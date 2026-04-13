const crypto = require('crypto');

const SESSION_COOKIE_NAME = 'cx_sid';

const SESSION_TTL_MS = toInt(process.env.SECURITY_SESSION_TTL_MS, 2 * 60 * 60 * 1000, 10 * 60 * 1000);
const TOKEN_TTL_MS = toInt(process.env.SECURITY_TOKEN_TTL_MS, 90 * 1000, 10 * 1000);
const TOKEN_MAX_USES = toInt(process.env.SECURITY_TOKEN_MAX_USES, 8, 1);

const rateLimitStore = new Map();
const sessionStore = new Map();

const cleanupTimer = setInterval(cleanupMemoryStores, 60 * 1000);
if (typeof cleanupTimer.unref === 'function') {
  cleanupTimer.unref();
}

function toInt(value, fallback, min = 1) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min) return fallback;
  return parsed;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return (req.ip || req.socket?.remoteAddress || 'unknown').toString();
}

function parseCookies(req) {
  const rawCookie = req.headers.cookie;
  if (!rawCookie) return {};

  const result = {};
  const segments = rawCookie.split(';');
  for (const segment of segments) {
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

function buildCorsOptions() {
  const fromEnv = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const allowList = new Set(fromEnv);
  const isProduction = process.env.NODE_ENV === 'production';

  return {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      if (allowList.size === 0) {
        if (isProduction) {
          callback(new Error('CORS_ORIGINS_NOT_CONFIGURED'));
          return;
        }
        callback(null, true);
        return;
      }

      if (allowList.has(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error('CORS_NOT_ALLOWED'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CX-Request-Token', 'X-CX-Request-Id'],
    maxAge: 600
  };
}

function applySecurityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
}

function attachRequestId(req, res, next) {
  const incomingId = req.headers['x-cx-request-id'];
  const requestId = typeof incomingId === 'string' && incomingId.trim()
    ? incomingId.trim().slice(0, 128)
    : crypto.randomBytes(12).toString('hex');

  req.requestId = requestId;
  res.setHeader('X-CX-Request-Id', requestId);
  next();
}

function createMemoryRateLimiter(options = {}) {
  const windowMs = toInt(options.windowMs, 60 * 1000, 1000);
  const max = toInt(options.max, 120, 1);
  const scope = options.scope || 'default';

  return (req, res, next) => {
    const now = Date.now();
    const ip = getClientIp(req);
    const key = `${scope}:${ip}`;
    let state = rateLimitStore.get(key);

    if (!state || now > state.windowEnd) {
      state = {
        count: 0,
        windowEnd: now + windowMs
      };
    }

    state.count += 1;
    rateLimitStore.set(key, state);

    const remaining = Math.max(0, max - state.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(state.windowEnd));

    if (state.count > max) {
      res.status(429).json({
        error: '请求过于频繁，请稍后重试',
        code: 'RATE_LIMIT_EXCEEDED'
      });
      return;
    }

    next();
  };
}

function issueSecurityBootstrap(req, res) {
  const session = ensureSession(req, res);
  const tokenValue = createToken(session);
  const tokenInfo = session.tokens.get(tokenValue);

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    requestToken: tokenValue,
    expiresAt: tokenInfo.expiresAt,
    maxUses: TOKEN_MAX_USES
  });
}

function verifyProtectedRequest(req, res, next) {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    next();
    return;
  }

  const session = getExistingSession(req);
  if (!session) {
    rejectInvalidToken(res);
    return;
  }

  cleanupSessionTokens(session, Date.now());

  const requestToken = req.headers['x-cx-request-token'];
  if (typeof requestToken !== 'string' || !requestToken.trim()) {
    rejectInvalidToken(res);
    return;
  }

  const tokenInfo = session.tokens.get(requestToken.trim());
  if (!tokenInfo) {
    rejectInvalidToken(res);
    return;
  }

  if (tokenInfo.expiresAt < Date.now()) {
    session.tokens.delete(requestToken.trim());
    rejectInvalidToken(res);
    return;
  }

  tokenInfo.remainingUses -= 1;
  if (tokenInfo.remainingUses <= 0) {
    session.tokens.delete(requestToken.trim());
  }

  session.lastSeenAt = Date.now();
  next();
}

function rejectInvalidToken(res) {
  res.setHeader('x-cx-token-invalid', '1');
  res.status(403).json({
    error: '请求校验失败，请刷新页面后重试',
    code: 'SECURITY_TOKEN_INVALID'
  });
}

function ensureSession(req, res) {
  const existing = getExistingSession(req);
  if (existing) {
    existing.lastSeenAt = Date.now();
    return existing;
  }

  const sessionId = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  const session = {
    id: sessionId,
    createdAt: now,
    lastSeenAt: now,
    ip: getClientIp(req),
    tokens: new Map()
  };
  sessionStore.set(sessionId, session);

  const forceSecure = String(process.env.COOKIE_SECURE || '').toLowerCase() === 'true';
  const cookieSecure = forceSecure || (process.env.NODE_ENV === 'production' && req.secure);
  const serialized = serializeCookie(SESSION_COOKIE_NAME, sessionId, {
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    httpOnly: true,
    sameSite: 'Lax',
    secure: cookieSecure
  });
  res.append('Set-Cookie', serialized);

  return session;
}

function getExistingSession(req) {
  const cookies = parseCookies(req);
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (!sessionId) return null;

  const session = sessionStore.get(sessionId);
  if (!session) return null;

  if (session.lastSeenAt + SESSION_TTL_MS < Date.now()) {
    sessionStore.delete(sessionId);
    return null;
  }

  return session;
}

function createToken(session) {
  cleanupSessionTokens(session, Date.now());
  if (session.tokens.size > 30) {
    session.tokens.clear();
  }

  const value = crypto.randomBytes(24).toString('base64url');
  session.tokens.set(value, {
    expiresAt: Date.now() + TOKEN_TTL_MS,
    remainingUses: TOKEN_MAX_USES
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

function cleanupMemoryStores() {
  const now = Date.now();

  for (const [key, state] of rateLimitStore.entries()) {
    if (now > state.windowEnd + 60 * 1000) {
      rateLimitStore.delete(key);
    }
  }

  for (const [sessionId, session] of sessionStore.entries()) {
    if (session.lastSeenAt + SESSION_TTL_MS < now) {
      sessionStore.delete(sessionId);
      continue;
    }
    cleanupSessionTokens(session, now);
  }
}

module.exports = {
  buildCorsOptions,
  applySecurityHeaders,
  attachRequestId,
  createMemoryRateLimiter,
  issueSecurityBootstrap,
  verifyProtectedRequest
};
