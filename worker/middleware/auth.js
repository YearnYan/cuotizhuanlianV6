import { getUserById } from '../services/account-store.js';
import { extractBearerToken, verifyToken } from '../services/token-service.js';

function unauthorized(c, message = '请先登录') {
  return c.json({ error: message, code: 'AUTH_REQUIRED' }, 401);
}

export async function requireUserAuth(c, next) {
  const token = extractBearerToken(c.req.raw);
  if (!token) return unauthorized(c, '请先登录账号后再使用');

  const payload = await verifyToken(c.env, token);
  if (!payload || payload.role !== 'user') {
    return unauthorized(c, '登录状态无效，请重新登录');
  }

  const user = await getUserById(payload.uid);
  if (!user) return unauthorized(c, '用户不存在或已失效');

  c.set('authUser', {
    id: user.id,
    username: user.username,
    points: user.points
  });
  await next();
}

export async function requireAdminAuth(c, next) {
  const token = extractBearerToken(c.req.raw);
  if (!token) return unauthorized(c, '请先登录管理员账号');

  const payload = await verifyToken(c.env, token);
  if (!payload || payload.role !== 'admin') {
    return unauthorized(c, '管理员登录状态无效');
  }

  c.set('authAdmin', {
    username: String(payload.username || 'admin')
  });
  await next();
}

