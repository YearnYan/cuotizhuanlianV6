const {
  getUserById
} = require('../services/account-store');
const {
  verifyToken,
  extractBearerToken
} = require('../services/token-service');

function unauthorized(res, message = '请先登录') {
  res.status(401).json({
    error: message,
    code: 'AUTH_REQUIRED'
  });
}

async function resolveAuthUser(req) {
  const token = extractBearerToken(req);
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  if (payload.role !== 'user') return null;
  const user = await getUserById(payload.uid);
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    points: user.points
  };
}

function requireUserAuth(req, res, next) {
  resolveAuthUser(req)
    .then((authUser) => {
      if (!authUser) {
        unauthorized(res, '请先登录账号后再使用');
        return;
      }
      req.authUser = authUser;
      next();
    })
    .catch((error) => {
      console.error('用户鉴权失败:', error.message);
      unauthorized(res, '登录状态异常，请重新登录');
    });
}

function requireAdminAuth(req, res, next) {
  const token = extractBearerToken(req);
  if (!token) {
    unauthorized(res, '请先登录管理员账号');
    return;
  }
  const payload = verifyToken(token);
  if (!payload || payload.role !== 'admin') {
    unauthorized(res, '管理员登录状态无效');
    return;
  }
  req.authAdmin = {
    username: String(payload.username || 'admin')
  };
  next();
}

module.exports = {
  requireUserAuth,
  requireAdminAuth
};

