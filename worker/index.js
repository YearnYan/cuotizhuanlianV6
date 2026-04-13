import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  securityHeaders,
  attachRequestId,
  createRateLimiter,
  issueSecurityBootstrap,
  verifyProtectedRequest
} from './middleware/security.js';
import { requireUserAuth } from './middleware/auth.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { examRoutes } from './routes/exam.js';
import { renderRoutes } from './routes/render.js';
import { authRoutes } from './routes/auth.js';
import { adminRoutes } from './routes/admin.js';
import { ADMIN_PAGE_HTML } from './views/admin-page.js';

const app = new Hono();

app.use('/api/*', cors({
  origin: (origin) => origin || '*',
  credentials: true,
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-CX-Request-Token', 'X-CX-Request-Id'],
  maxAge: 600
}));

app.use('/api/*', securityHeaders);
app.use('/api/*', attachRequestId);

app.use('/api/*', async (c, next) => {
  if (/\.map(?:$|\?)/i.test(c.req.path)) {
    return c.json({ error: 'Not Found' }, 404);
  }
  await next();
});

app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: Date.now() }));

app.get(
  '/api/security/bootstrap',
  createRateLimiter({ windowMs: 60000, max: 120, scope: 'bootstrap' }),
  issueSecurityBootstrap
);

app.route('/api/knowledge', (() => {
  const sub = new Hono();
  sub.use('*', createRateLimiter({ windowMs: 60000, max: 200, scope: 'knowledge' }));
  knowledgeRoutes(sub);
  return sub;
})());

app.route('/api/auth', (() => {
  const sub = new Hono();
  sub.use('*', createRateLimiter({ windowMs: 60000, max: 120, scope: 'auth' }));
  authRoutes(sub);
  return sub;
})());

app.route('/api/admin', (() => {
  const sub = new Hono();
  sub.use('*', createRateLimiter({ windowMs: 60000, max: 120, scope: 'admin' }));
  adminRoutes(sub);
  return sub;
})());

app.route('/api/exam', (() => {
  const sub = new Hono();
  sub.use('*', createRateLimiter({ windowMs: 60000, max: 40, scope: 'exam' }));
  sub.use('*', verifyProtectedRequest);
  sub.use('*', requireUserAuth);
  examRoutes(sub);
  return sub;
})());

app.route('/api/render', (() => {
  const sub = new Hono();
  sub.use('*', createRateLimiter({ windowMs: 60000, max: 90, scope: 'render' }));
  sub.use('*', verifyProtectedRequest);
  sub.use('*', requireUserAuth);
  renderRoutes(sub);
  return sub;
})());

app.get('/admin', (c) => {
  return c.html(ADMIN_PAGE_HTML);
});

app.all('*', async (c) => {
  try {
    const response = await c.env.ASSETS.fetch(c.req.raw);
    if (response.status === 404) {
      const url = new URL(c.req.url);
      url.pathname = '/index.html';
      return c.env.ASSETS.fetch(new Request(url.toString()));
    }
    return response;
  } catch {
    return c.text('Not Found', 404);
  }
});

export default app;

