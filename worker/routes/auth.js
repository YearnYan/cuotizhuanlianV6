import { registerUser, loginUser, getUserById, redeemCoupon } from '../services/account-store.js';
import { issueToken, verifyToken, extractBearerToken } from '../services/token-service.js';

function sanitizeAuthBody(body) {
  return {
    username: String(body?.username || '').trim(),
    password: String(body?.password || '')
  };
}

export function authRoutes(app) {
  app.post('/register', async (c) => {
    try {
      const payload = sanitizeAuthBody(await c.req.json());
      const user = await registerUser(c.env, payload);
      const token = await issueToken(c.env, {
        role: 'user',
        uid: user.id,
        username: user.username
      });
      return c.json({ token, user });
    } catch (error) {
      return c.json({ error: error.message || '注册失败' }, 400);
    }
  });

  app.post('/login', async (c) => {
    try {
      const payload = sanitizeAuthBody(await c.req.json());
      const user = await loginUser(c.env, payload);
      const token = await issueToken(c.env, {
        role: 'user',
        uid: user.id,
        username: user.username
      });
      return c.json({ token, user });
    } catch (error) {
      return c.json({ error: error.message || '登录失败' }, 400);
    }
  });

  app.get('/me', async (c) => {
    try {
      const token = extractBearerToken(c.req.raw);
      const payload = await verifyToken(c.env, token);
      if (!payload || payload.role !== 'user') {
        return c.json({ error: '未登录或登录已失效' }, 401);
      }
      const user = await getUserById(c.env, payload.uid);
      if (!user) {
        return c.json({ error: '用户不存在或已失效' }, 401);
      }
      return c.json({ user });
    } catch (error) {
      return c.json({ error: error.message || '读取用户信息失败' }, 500);
    }
  });

  app.post('/redeem', async (c) => {
    try {
      const token = extractBearerToken(c.req.raw);
      const payload = await verifyToken(c.env, token);
      if (!payload || payload.role !== 'user') {
        return c.json({ error: '请先登录后再兑换积分' }, 401);
      }
      const body = await c.req.json();
      const code = String(body?.code || '').trim();
      const result = await redeemCoupon(c.env, { userId: payload.uid, code });
      return c.json(result);
    } catch (error) {
      return c.json({ error: error.message || '兑换失败' }, 400);
    }
  });
}
