const crypto = require('crypto');

const DEFAULT_TTL_SECONDS = toInt(process.env.AUTH_TOKEN_TTL_SECONDS, 7 * 24 * 60 * 60);
const TOKEN_SECRET = String(process.env.AUTH_TOKEN_SECRET || '').trim() || crypto.randomBytes(32).toString('hex');

if (!process.env.AUTH_TOKEN_SECRET) {
  console.warn('[auth] 未配置 AUTH_TOKEN_SECRET，当前使用进程内随机密钥，重启后旧 token 会失效');
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function base64UrlEncode(input) {
  return Buffer.from(input).toString('base64url');
}

function base64UrlDecode(input) {
  return Buffer.from(String(input || ''), 'base64url').toString('utf8');
}

function signSegment(segment) {
  return crypto.createHmac('sha256', TOKEN_SECRET).update(segment).digest('base64url');
}

function issueToken(payload = {}, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + Math.max(60, Number.parseInt(ttlSeconds, 10) || DEFAULT_TTL_SECONDS);
  const data = {
    ...payload,
    iat: now,
    exp
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(data));
  const signature = signSegment(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) return null;
  const expected = signSegment(encodedPayload);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (!payload || typeof payload !== 'object') return null;
    const exp = Number.parseInt(payload.exp, 10);
    if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function extractBearerToken(req) {
  const auth = req.headers.authorization;
  if (!auth || typeof auth !== 'string') return '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

module.exports = {
  issueToken,
  verifyToken,
  extractBearerToken
};

