const express = require('express');
const router = express.Router();
const {
  issueToken
} = require('../services/token-service');
const {
  requireAdminAuth
} = require('../middleware/auth');
const {
  generateCoupons,
  listCoupons,
  getAdminStats
} = require('../services/account-store');
const {
  getAIKeyPoolSnapshot
} = require('../services/ai-key-pool');

const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || 'admin').trim();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || 'admin123456');

router.post('/login', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  if (!username || !password) {
    return res.status(400).json({ error: '请输入管理员用户名和密码' });
  }
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: '管理员账号或密码错误' });
  }
  const token = issueToken({ role: 'admin', username: ADMIN_USERNAME });
  return res.json({
    token,
    admin: { username: ADMIN_USERNAME }
  });
});

router.get('/stats', requireAdminAuth, async (req, res) => {
  try {
    const stats = await getAdminStats();
    return res.json({
      ...stats,
      aiKeyPool: getAIKeyPoolSnapshot()
    });
  } catch (error) {
    return res.status(500).json({ error: '读取统计数据失败' });
  }
});

router.get('/coupons', requireAdminAuth, async (req, res) => {
  try {
    const limit = Number.parseInt(req.query?.limit, 10) || 200;
    const coupons = await listCoupons({ limit });
    return res.json({ coupons });
  } catch (error) {
    return res.status(500).json({ error: '读取兑换券失败' });
  }
});

router.post('/coupons/batch', requireAdminAuth, async (req, res) => {
  try {
    const points = Number.parseInt(req.body?.points, 10);
    const quantity = Number.parseInt(req.body?.quantity, 10);
    const coupons = await generateCoupons({
      points,
      quantity,
      createdBy: req.authAdmin?.username || ADMIN_USERNAME
    });
    return res.json({
      created: coupons.length,
      coupons
    });
  } catch (error) {
    return res.status(400).json({ error: error.message || '生成兑换券失败' });
  }
});

module.exports = router;
