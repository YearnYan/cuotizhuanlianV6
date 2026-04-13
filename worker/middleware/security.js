const SESSION_COOKIE_NAME = 'cx_sid';
const DEFAULT_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_TOKEN_TTL_MS = 90 * 1000;
const DEFAULT_TOKEN_MAX_USES = 8;

// In-memory stores (per-isolate in Workers, acceptable for trial version)
const rateLimitStore = new Map();
const sessionStore = new Map();

// Periodic cleanup
let lastCleanup = 0;
function maybeCleanup() {
  const now = Date.now();
  if (now - lastCleanup < 60000) return;
  lastCleanup = now;

  for (const [key, state] of rateLimitStore.entries()) {
    if (now > state.windowEnd + 60000) rateLimitStore.delete(key);
  }

  for (const [sid, session] of sessionStore.entries()) {
    if (session.lastSeenAt + DEFAULT_SESSION_TTL_MS < now) {
      sessionStore.delete(sid);
      continue;
    }
    cleanupSessionTokens(session, now);
  }
}

function toInt(value, fallback, min = 1) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

function getClientIp(c) {
  return c.req.header('cf-connecting-ip')
    || c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || '0.0.0.0';
}

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

function randomBase64url(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  let binary = '';
  for (const b of arr) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function parseCookies(c) {
  const raw = c.req.header('cookie');
  if (!raw) return {};
  const result = {};
  for (const segment of raw.split(';')) {
    const [rawName, ...rest] = segment.trim().split('=');
    if (!rawName) continue;
    result[rawName] = decodeURIComponent(rest.join('=') || '');
  }
  return result;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);
  if (Number.isFinite(options.maxAge)) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

// Middleware: Security headers
export async function securityHeaders(c, next) {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'SAMEORIGIN');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
  c.header('X-Robots-Tag', 'noindex, nofollow');
}

// Middleware: Attach request ID
export async function attachRequestId(c, next) {
  const incomingId = c.req.header('x-cx-request-id');
  const requestId = (incomingId && incomingId.trim())
    ? incomingId.trim().slice(0, 128)
    : randomHex(12);
  c.set('requestId', requestId);
  c.header('X-CX-Request-Id', requestId);
  await next();
}

// Middleware: Rate limiter
export function createRateLimiter(options = {}) {
  const windowMs = toInt(options.windowMs, 60000, 1000);
  const max = toInt(options.max, 120, 1);
  const scope = options.scope || 'default';

  return async (c, next) => {
    maybeCleanup();
    const now = Date.now();
    const ip = getClientIp(c);
    const key = `${scope}:${ip}`;
    let state = rateLimitStore.get(key);

    if (!state || now > state.windowEnd) {
      state = { count: 0, windowEnd: now + windowMs };
    }

    state.count += 1;
    rateLimitStore.set(key, state);

    const remaining = Math.max(0, max - state.count);
    c.header('X-RateLimit-Limit', String(max));
    c.header('X-RateLimit-Remaining', String(remaining));
    c.header('X-RateLimit-Reset', String(state.windowEnd));

    if (state.count > max) {
      return c.json({ error: '请求过于频繁，请稍后重试', code: 'RATE_LIMIT_EXCEEDED' }, 429);
    }

    await next();
  };
}

// Handler: Security bootstrap (issue session + token)
export async function issueSecurityBootstrap(c) {
  maybeCleanup();
  const session = ensureSession(c);
  const tokenValue = createToken(session);
  const tokenInfo = session.tokens.get(tokenValue);

  c.header('Cache-Control', 'no-store');
  return c.json({
    requestToken: tokenValue,
    expiresAt: tokenInfo.expiresAt,
    maxUses: DEFAULT_TOKEN_MAX_USES
  });
}

// Middleware: Verify protected request
export async function verifyProtectedRequest(c, next) {
  maybeCleanup();
  const method = c.req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    await next();
    return;
  }

  const session = getExistingSession(c);
  if (!session) return rejectInvalidToken(c);

  cleanupSessionTokens(session, Date.now());

  const requestToken = c.req.header('x-cx-request-token');
  if (!requestToken || !requestToken.trim()) return rejectInvalidToken(c);

  const tokenInfo = session.tokens.get(requestToken.trim());
  if (!tokenInfo) return rejectInvalidToken(c);

  if (tokenInfo.expiresAt < Date.now()) {
    session.tokens.delete(requestToken.trim());
    return rejectInvalidToken(c);
  }

  tokenInfo.remainingUses -= 1;
  if (tokenInfo.remainingUses <= 0) {
    session.tokens.delete(requestToken.trim());
  }

  session.lastSeenAt = Date.now();
  await next();
}

function rejectInvalidToken(c) {
  c.header('x-cx-token-invalid', '1');
  return c.json({
    error: '请求校验失败，请刷新页面后重试',
    code: 'SECURITY_TOKEN_INVALID'
  }, 403);
}

function ensureSession(c) {
  const existing = getExistingSession(c);
  if (existing) {
    existing.lastSeenAt = Date.now();
    return existing;
  }

  const sessionId = randomHex(24);
  const now = Date.now();
  const session = {
    id: sessionId,
    createdAt: now,
    lastSeenAt: now,
    ip: getClientIp(c),
    tokens: new Map()
  };
  sessionStore.set(sessionId, session);

  const serialized = serializeCookie(SESSION_COOKIE_NAME, sessionId, {
    path: '/',
    maxAge: Math.floor(DEFAULT_SESSION_TTL_MS / 1000),
    httpOnly: true,
    sameSite: 'Lax',
    secure: true
  });
  c.header('Set-Cookie', serialized);

  return session;
}

function getExistingSession(c) {
  const cookies = parseCookies(c);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (!sessionId) return null;

  const session = sessionStore.get(sessionId);
  if (!session) return null;

  if (session.lastSeenAt + DEFAULT_SESSION_TTL_MS < Date.now()) {
    sessionStore.delete(sessionId);
    return null;
  }

  return session;
}

function createToken(session) {
  cleanupSessionTokens(session, Date.now());
  if (session.tokens.size > 30) session.tokens.clear();

  const value = randomBase64url(24);
  session.tokens.set(value, {
    expiresAt: Date.now() + DEFAULT_TOKEN_TTL_MS,
    remainingUses: DEFAULT_TOKEN_MAX_USES
  });
  return value;
}

function cleanupSessionTokens(session, now) {
  for (const [token, info] of session.tokens.entries()) {
    if (info.expiresAt < now || info.remainingUses <= 0) {
      session.tokens.delete(token);
    }
  }
}
