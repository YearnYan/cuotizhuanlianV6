import { createAIClient, generateContent } from '../services/ai.js';

// SVG cache (per-isolate, ephemeral)
const svgCache = new Map();

function ensureStyle(svg) {
  const style = 'max-width:280px;height:auto;display:block;margin:8px auto;overflow:visible';
  if (!svg.includes('style=')) {
    return svg.replace('<svg', `<svg style="${style}"`);
  }
  return svg;
}

async function generateSVG(client, env, description, subject, stem = '', retryCount = 0) {
  const maxRetries = 2;

  const systemPrompt = `你是专业的SVG图形生成器，为K12试卷生成精确的数学、物理、化学图形。

# 核心要求
1. **必须输出完整的SVG代码** - 从<svg>开始到</svg>结束
2. **严格按照题目要求生成**
3. **精确绘制** - 准确绘制函数、点、线、角度
4. **清晰标注** - 标注所有关键元素
5. **完整内容** - 不要只画空白坐标系

# 技术规范
- viewBox="0 0 400 300"
- 线条：stroke="#333" stroke-width="2" fill="none"
- 文字：font-size="14" font-family="Arial,sans-serif" fill="#000"
- 点标注：<circle r="3" fill="#333"/>

**重要：只输出SVG代码，不要任何解释文字。**`;

  const userPrompt = `科目：${subject}\n\n题目：${stem}\n\n图形要求：${description}\n\n请生成精确的SVG图形。只输出SVG代码。`;

  try {
    const content = await generateContent(client, env, systemPrompt, userPrompt, {
      maxTokens: 2500, temperature: 0.2
    });

    const svgMatch = content.match(/<svg[\s\S]*?<\/svg>/i);
    if (svgMatch) return ensureStyle(svgMatch[0]);

    if (retryCount < maxRetries) {
      console.warn(`[SVG] 未找到SVG标签，重试 ${retryCount + 1}/${maxRetries}`);
      return generateSVG(client, env, description, subject, stem, retryCount + 1);
    }
    return null;
  } catch (e) {
    if (retryCount < maxRetries && (e.message.includes('timeout') || e.message.includes('network'))) {
      return generateSVG(client, env, description, subject, stem, retryCount + 1);
    }
    console.error(`[SVG] 生成失败 - ${e.message}`);
    return null;
  }
}

export function renderRoutes(app) {
  // POST /figure
  app.post('/figure', async (c) => {
    try {
      const body = await c.req.json();
      const { description, tikzCode, subject } = body;
      if (!description && !tikzCode) return c.json({ error: '缺少图形描述' }, 400);

      const cacheKey = description || tikzCode;
      if (svgCache.has(cacheKey)) {
        return c.json({ svg: svgCache.get(cacheKey), cached: true });
      }

      const client = createAIClient(c.env);
      const svg = await generateSVG(client, c.env, description || tikzCode, subject || '');
      if (svg) {
        svgCache.set(cacheKey, svg);
        return c.json({ svg, cached: false });
      }
      return c.json({ svg: null });
    } catch (error) {
      console.error('图形渲染失败:', error.message);
      return c.json({ error: '渲染失败' }, 500);
    }
  });

  // POST /figures-batch
  app.post('/figures-batch', async (c) => {
    try {
      const body = await c.req.json();
      const { figures } = body;
      if (!Array.isArray(figures) || figures.length === 0) {
        return c.json({ error: 'figures必须是非空数组' }, 400);
      }

      const cached = [];
      const uncached = [];

      for (const fig of figures) {
        const key = fig.description || fig.tikzCode || '';
        if (svgCache.has(key)) {
          cached.push({ id: fig.id, svg: svgCache.get(key), cached: true });
        } else if (key) {
          uncached.push(fig);
        } else {
          cached.push({ id: fig.id, svg: null });
        }
      }

      let uncachedResults = [];
      if (uncached.length > 0) {
        const client = createAIClient(c.env);
        const promises = uncached.map(fig => {
          const desc = fig.description || fig.tikzCode || '';
          return generateSVG(client, c.env, desc, fig.subject || '', fig.stem || '')
            .then(svg => ({ id: fig.id, svg, cached: false }))
            .catch(() => ({ id: fig.id, svg: null, cached: false }));
        });
        uncachedResults = await Promise.all(promises);
        uncachedResults.forEach(r => {
          if (r.svg) {
            const fig = uncached.find(f => f.id === r.id);
            if (fig) svgCache.set(fig.description || fig.tikzCode, r.svg);
          }
        });
      }

      return c.json({ results: [...cached, ...uncachedResults] });
    } catch (error) {
      console.error('批量渲染失败:', error.message);
      return c.json({ error: '批量渲染失败' }, 500);
    }
  });
}
