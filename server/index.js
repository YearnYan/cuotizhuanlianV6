const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const {
  buildCorsOptions,
  applySecurityHeaders,
  attachRequestId,
  createMemoryRateLimiter,
  issueSecurityBootstrap,
  verifyProtectedRequest
} = require('./middleware/security');
const {
  requireUserAuth
} = require('./middleware/auth');

const knowledgeRouter = require('./routes/knowledge');
const examRouter = require('./routes/exam');
const renderRouter = require('./routes/render');
const authRouter = require('./routes/auth');
const adminRouter = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors(buildCorsOptions()));
app.use(applySecurityHeaders);
app.use(attachRequestId);
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  if (/\.map(?:$|\?)/i.test(req.originalUrl || req.url || '')) {
    res.status(404).json({ error: 'Not Found' });
    return;
  }
  next();
});

app.use(express.static(path.join(__dirname, '../dist'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store');
  }
}));

app.get(
  '/api/security/bootstrap',
  createMemoryRateLimiter({ windowMs: 60 * 1000, max: 120, scope: 'bootstrap' }),
  issueSecurityBootstrap
);

app.use(
  '/api/knowledge',
  createMemoryRateLimiter({ windowMs: 60 * 1000, max: 200, scope: 'knowledge' }),
  knowledgeRouter
);

app.use(
  '/api/auth',
  createMemoryRateLimiter({ windowMs: 60 * 1000, max: 120, scope: 'auth' }),
  authRouter
);

app.use(
  '/api/admin',
  createMemoryRateLimiter({ windowMs: 60 * 1000, max: 120, scope: 'admin' }),
  adminRouter
);

app.use(
  '/api/exam',
  createMemoryRateLimiter({ windowMs: 60 * 1000, max: 40, scope: 'exam' }),
  verifyProtectedRequest,
  requireUserAuth,
  examRouter
);

app.use(
  '/api/render',
  createMemoryRateLimiter({ windowMs: 60 * 1000, max: 90, scope: 'render' }),
  verifyProtectedRequest,
  requireUserAuth,
  renderRouter
);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, './views/admin.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/index.html'));
});

app.listen(PORT, () => {
  console.log(`服务已启动: http://localhost:${PORT}`);
});
