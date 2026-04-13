const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

let runtimeSecret = '';
const hmacKeyCache = new Map();

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function getSecret(env) {
  const secret = String(env?.AUTH_TOKEN_SECRET || '').trim();
  if (secret) return secret;
  if (!runtimeSecret) {
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    runtimeSecret = Array.from(arr, (v) => v.toString(16).padStart(2, '0')).join('');
  }
  return runtimeSecret;
}

function base64UrlEncode(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let bin = '';
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecodeToBytes(input) {
  const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function base64UrlDecodeToString(input) {
  return new TextDecoder().decode(base64UrlDecodeToBytes(input));
}

async function getHmacKey(secret) {
  if (hmacKeyCache.has(secret)) return hmacKeyCache.get(secret);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  hmacKeyCache.set(secret, key);
  return key;
}

async function signSegment(segment, env) {
  const secret = getSecret(env);
  const key = await getHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(segment));
  return base64UrlEncode(new Uint8Array(sig));
}

function safeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function issueToken(env, payload = {}, ttlSeconds = null) {
  const now = Math.floor(Date.now() / 1000);
  const envTtl = toInt(env?.AUTH_TOKEN_TTL_SECONDS, DEFAULT_TTL_SECONDS);
  const ttl = Math.max(60, Number.parseInt(ttlSeconds, 10) || envTtl);
  const exp = now + ttl;
  const body = {
    ...payload,
    iat: now,
    exp
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(body));
  const signature = await signSegment(encodedPayload, env);
  return `${encodedPayload}.${signature}`;
}

export async function verifyToken(env, token) {
  if (!token || typeof token !== 'string') return null;
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) return null;

  const expected = await signSegment(encodedPayload, env);
  if (!safeEqual(expected, signature)) return null;

  try {
    const payload = JSON.parse(base64UrlDecodeToString(encodedPayload));
    if (!payload || typeof payload !== 'object') return null;
    const exp = Number.parseInt(payload.exp, 10);
    if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function extractBearerToken(requestLike) {
  const auth = requestLike?.headers?.get
    ? requestLike.headers.get('authorization')
    : requestLike?.headers?.authorization;
  if (!auth || typeof auth !== 'string') return '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

