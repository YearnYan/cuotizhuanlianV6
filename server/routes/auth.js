const express = require('express');
const router = express.Router();
const {
  registerUser,
  loginUser,
  getUserById,
  redeemCoupon
} = require('../services/account-store');
const {
  issueToken,
  verifyToken,
  extractBearerToken
} = require('../services/token-service');

function sanitizeAuthBody(body) {
  return {
    username: String(body?.username || '').trim(),
    password: String(body?.password || '')
  };
}

router.post('/register', async (req, res) => {
  try {
    const payload = sanitizeAuthBody(req.body);
    const user = await registerUser(payload);
    const token = issueToken({ role: 'user', uid: user.id, username: user.username });
    res.json({
      token,
      user
    });
  } catch (error) {
    res.status(400).json({ error: error.message || '注册失败' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const payload = sanitizeAuthBody(req.body);
    const user = await loginUser(payload);
    const token = issueToken({ role: 'user', uid: user.id, username: user.username });
    res.json({
      token,
      user
    });
  } catch (error) {
    res.status(400).json({ error: error.message || '登录失败' });
  }
});

router.get('/me', async (req, res) => {
  try {
    const token = extractBearerToken(req);
    const payload = verifyToken(token);
    if (!payload || payload.role !== 'user') {
      return res.status(401).json({ error: '未登录或登录已失效' });
    }
    const user = await getUserById(payload.uid);
    if (!user) {
      return res.status(401).json({ error: '用户不存在或已失效' });
    }
    return res.json({ user });
  } catch (error) {
    return res.status(500).json({ error: '读取用户信息失败' });
  }
});

router.post('/redeem', async (req, res) => {
  try {
    const token = extractBearerToken(req);
    const payload = verifyToken(token);
    if (!payload || payload.role !== 'user') {
      return res.status(401).json({ error: '请先登录后再兑换积分' });
    }
    const code = String(req.body?.code || '').trim();
    const result = await redeemCoupon({
      userId: payload.uid,
      code
    });
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ error: error.message || '兑换失败' });
  }
});

module.exports = router;

