import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { securityHeaders, attachRequestId, createRateLimiter, issueSecurityBootstrap, verifyProtectedRequest } from './middleware/security.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { examRoutes } from './routes/exam.js';
import { renderRoutes } from './routes/render.js';

const app = new Hono();

// CORS
app.use('/api/*', cors({
  origin: (origin) => origin || '*',
  credentials: true,
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'X-CX-Request-Token', 'X-CX-Request-Id'],
  maxAge: 600
}));

// Security headers
app.use('/api/*', securityHeaders);

// Request ID
app.use('/api/*', attachRequestId);

// Block source maps
app.use('/api/*', async (c, next) => {
  if (/\.map(?:$|\?)/i.test(c.req.path)) {
    return c.json({ error: 'Not Found' }, 404);
  }
  await next();
});

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: Date.now() }));

// Security bootstrap
app.get('/api/security/bootstrap',
  createRateLimiter({ windowMs: 60000, max: 120, scope: 'bootstrap' }),
  issueSecurityBootstrap
);

// Knowledge routes (public)
app.route('/api/knowledge',
  (() => {
    const sub = new Hono();
    sub.use('*', createRateLimiter({ windowMs: 60000, max: 200, scope: 'knowledge' }));
    knowledgeRoutes(sub);
    return sub;
  })()
);

// Exam routes (protected)
app.route('/api/exam',
  (() => {
    const sub = new Hono();
    sub.use('*', createRateLimiter({ windowMs: 60000, max: 40, scope: 'exam' }));
    sub.use('*', verifyProtectedRequest);
    examRoutes(sub);
    return sub;
  })()
);

// Render routes (protected)
app.route('/api/render',
  (() => {
    const sub = new Hono();
    sub.use('*', createRateLimiter({ windowMs: 60000, max: 90, scope: 'render' }));
    sub.use('*', verifyProtectedRequest);
    renderRoutes(sub);
    return sub;
  })()
);

// Catch-all: serve static assets with SPA fallback
app.all('*', async (c) => {
  try {
    const response = await c.env.ASSETS.fetch(c.req.raw);
    if (response.status === 404) {
      // SPA fallback: serve index.html
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
