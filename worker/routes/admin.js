import { requireAdminAuth } from '../middleware/auth.js';
import { issueToken } from '../services/token-service.js';
import { generateCoupons, listCoupons, getAdminStats } from '../services/account-store.js';
import { getAIKeyPoolSnapshot } from '../services/ai-key-pool.js';

function getAdminCredentials(env) {
  return {
    username: String(env?.ADMIN_USERNAME || 'admin').trim(),
    password: String(env?.ADMIN_PASSWORD || 'admin123456').trim()
  };
}

export function adminRoutes(app) {
  app.post('/login', async (c) => {
    try {
      const body = await c.req.json();
      const username = String(body?.username || '').trim();
      const password = String(body?.password || '').trim();
      if (!username || !password) {
        return c.json({ error: '请输入管理员用户名和密码' }, 400);
      }

      const admin = getAdminCredentials(c.env);
      if (username !== admin.username || password !== admin.password) {
        return c.json({ error: '管理员账号或密码错误' }, 401);
      }

      const token = await issueToken(c.env, {
        role: 'admin',
        username: admin.username
      });
      return c.json({
        token,
        admin: { username: admin.username }
      });
    } catch (error) {
      return c.json({ error: error.message || '管理员登录失败' }, 500);
    }
  });

  app.get('/stats', requireAdminAuth, async (c) => {
    try {
      const stats = await getAdminStats(c.env);
      return c.json({
        ...stats,
        aiKeyPool: getAIKeyPoolSnapshot(c.env)
      });
    } catch (error) {
      return c.json({ error: error.message || '读取统计数据失败' }, 500);
    }
  });

  app.get('/coupons', requireAdminAuth, async (c) => {
    try {
      const limit = Number.parseInt(c.req.query('limit'), 10) || 200;
      const coupons = await listCoupons(c.env, { limit });
      return c.json({ coupons });
    } catch (error) {
      return c.json({ error: error.message || '读取兑换券失败' }, 500);
    }
  });

  app.post('/coupons/batch', requireAdminAuth, async (c) => {
    try {
      const body = await c.req.json();
      const points = Number.parseInt(body?.points, 10);
      const quantity = Number.parseInt(body?.quantity, 10);
      const authAdmin = c.get('authAdmin');
      const coupons = await generateCoupons(c.env, {
        points,
        quantity,
        createdBy: authAdmin?.username || 'admin'
      });
      return c.json({
        created: coupons.length,
        coupons
      });
    } catch (error) {
      return c.json({ error: error.message || '生成兑换券失败' }, 400);
    }
  });
}
