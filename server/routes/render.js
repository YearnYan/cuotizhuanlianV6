const express = require('express');
const router = express.Router();
const { generateContent } = require('../services/ai');

// SVG缓存
const svgCache = new Map();

function extractFigureLabelTokens(text) {
  const normalized = String(text || '').toUpperCase();
  const matches = normalized.match(/\b(?:S\d+|R\d+|L\d+|S|R|L)\b/g) || [];
  const unique = Array.from(new Set(matches));
  const hasSpecific = unique.some((token) => /\d/.test(token));
  return hasSpecific
    ? unique.filter((token) => /\d/.test(token))
    : unique.filter((token) => token === 'S' || token === 'R' || token === 'L');
}

function buildFigureCacheKey({ description = '', tikzCode = '', subject = '', stem = '' }) {
  return JSON.stringify({
    d: String(description || '').trim(),
    t: String(tikzCode || '').trim(),
    s: String(subject || '').trim(),
    q: String(stem || '').trim()
  });
}

/**
 * POST /api/render/figure
 * 单个图形渲染
 */
router.post('/figure', async (req, res) => {
  try {
    const { description, tikzCode, subject, stem = '' } = req.body;
    if (!description && !tikzCode) {
      return res.status(400).json({ error: '缺少图形描述' });
    }

    const cacheKey = buildFigureCacheKey({ description, tikzCode, subject, stem });
    if (svgCache.has(cacheKey)) {
      return res.json({ svg: svgCache.get(cacheKey), cached: true });
    }

    const svg = await generateSVG(description || tikzCode, subject || '', stem || '');
    if (svg) {
      svgCache.set(cacheKey, svg);
      res.json({ svg, cached: false });
    } else {
      res.json({ svg: null });
    }
  } catch (error) {
    console.error('图形渲染失败:', error.message);
    res.status(500).json({ error: '渲染失败' });
  }
});

/**
 * POST /api/render/figures-batch
 * 批量渲染：一次AI调用生成多个SVG
 */
router.post('/figures-batch', async (req, res) => {
  try {
    const { figures } = req.body;
    if (!Array.isArray(figures) || figures.length === 0) {
      return res.status(400).json({ error: 'figures必须是非空数组' });
    }

    // 分离已缓存和未缓存的
    const cached = [];
    const uncached = [];

    for (const fig of figures) {
      const key = buildFigureCacheKey(fig || {});
      if (svgCache.has(key)) {
        cached.push({ id: fig.id, svg: svgCache.get(key), cached: true });
      } else if (fig.description || fig.tikzCode) {
        uncached.push({ ...fig, __cacheKey: key });
      } else {
        cached.push({ id: fig.id, svg: null });
      }
    }

    // 未缓存的合并成一次AI调用
    let uncachedResults = [];
    if (uncached.length > 0) {
      uncachedResults = await generateMultipleSVGs(uncached);
      // 写入缓存
      uncachedResults.forEach(r => {
        if (r.svg) {
          const fig = uncached.find(f => f.id === r.id);
          if (fig && fig.__cacheKey) svgCache.set(fig.__cacheKey, r.svg);
        }
      });
    }

    res.json({ results: [...cached, ...uncachedResults] });
  } catch (error) {
    console.error('批量渲染失败:', error.message);
    res.status(500).json({ error: '批量渲染失败' });
  }
});

/**
 * 并发生成多个SVG（核心优化）
 * 使用Promise.all并发调用，大幅提升速度
 */
async function generateMultipleSVGs(figures) {
  console.log(`[SVG] 并发生成 ${figures.length} 个图形...`);
  const startTime = Date.now();

  const promises = figures.map(fig => {
    const desc = fig.description || fig.tikzCode || '';
    const stem = fig.stem || '';
    const subject = fig.subject || '';
    console.log(`[SVG] 开始生成 ${fig.id}: ${desc.substring(0, 50)}...`);
    return generateSVG(desc, subject, stem)
      .then(svg => ({ id: fig.id, svg, cached: false }))
      .catch(() => ({ id: fig.id, svg: null, cached: false }));
  });

  const results = await Promise.all(promises);
  console.log(`[SVG] 全部完成，耗时 ${Date.now() - startTime}ms`);
  return results;
}

/**
 * 单个SVG生成（核心函数，带重试机制）
 */
async function generateSVG(description, subject, stem = '', retryCount = 0) {
  const maxRetries = 2;
  const labelTokens = extractFigureLabelTokens(stem);
  const labelRule = labelTokens.length > 0
    ? `题干关键元件标签：${labelTokens.join('、')}。绘图时必须全部出现，且不得新增其他同类标签。`
    : '若题干未给具体编号，按题干原文绘制，不得擅自新增元件编号。';

  const systemPrompt = `你是专业的SVG图形生成器，为K12试卷生成精确的数学、物理、化学图形。

# 核心要求
1. **必须输出完整的SVG代码** - 从<svg>开始到</svg>结束
2. **严格按照题目要求生成** - 仔细阅读题干，理解题目要求什么图形
3. **精确绘制** - 如果题目提到具体的函数、点、线、角度，必须准确绘制
4. **清晰标注** - 标注所有关键元素（点、线、角度、坐标等）
5. **完整内容** - 不要只画空白坐标系，要根据题目画出具体内容

# 图文一致性硬规则
- 必须同时满足“题目”和“图形要求”，冲突时以题目为准并修正为一致
- 禁止新增题干未出现的关键元件/标签（例如题干只有 S，不能画 S1/S2）
- 禁止遗漏题干中明确给出的元件、编号、阻值或其他关键参数
- 电路题中元件标签必须与题干逐项一致（如 S1、S2、R1、R2、L）

# 技术规范
- viewBox="0 0 400 300"
- 线条：stroke="#333" stroke-width="2" fill="none"
- 文字：font-size="14" font-family="Arial,sans-serif" fill="#000"
- 点标注：<circle r="3" fill="#333"/>
- 坐标轴：带箭头，标注O、x、y

# 常见图形类型

## 函数图像
- 画完整坐标系（x轴、y轴、原点O）
- 根据题目中的函数表达式画出曲线
- 标注关键点（如交点、极值点等）
- 例如：y=e^x 画指数曲线，y=sin(x) 画正弦曲线

## 几何图形
- 三角形：标注顶点A、B、C，标注边长和角度
- 圆：标注圆心O、半径
- 标注题目中提到的所有元素

**重要：只输出SVG代码，不要任何解释文字或其他内容。**`;

  const userPrompt = `科目：${subject}

题目：${stem}

图形要求：${description}
图文一致性检查清单：${labelRule}

请根据题目要求生成精确的SVG图形。注意：
1. 如果题目提到具体的函数（如 y=e^x, y=ln(x)），必须画出该函数的图像
2. 如果题目提到具体的点或线，必须在图中标出
3. 不要只画空白坐标系，要画出题目要求的具体内容
4. 只输出SVG代码，不要其他任何文字`;

  try {
    const content = await generateContent(systemPrompt, userPrompt, {
      maxTokens: 2500,
      temperature: 0.2
    });

    const svgMatch = content.match(/<svg[\s\S]*?<\/svg>/i);
    if (svgMatch) {
      return ensureStyle(svgMatch[0]);
    }

    // 如果没有找到SVG标签，尝试重试
    if (retryCount < maxRetries) {
      console.warn(`[SVG] 未找到SVG标签，重试 ${retryCount + 1}/${maxRetries}`);
      await new Promise(resolve => setTimeout(resolve, 500)); // 等待500ms
      return generateSVG(description, subject, stem, retryCount + 1);
    }

    console.warn(`[SVG] 重试${maxRetries}次后仍失败 - 题目: ${stem.substring(0, 50)}...`);
    console.warn(`[SVG] AI返回: ${content.substring(0, 200)}`);
    return null;
  } catch (e) {
    // 如果是网络错误或超时，尝试重试
    if (retryCount < maxRetries && (e.message.includes('timeout') || e.message.includes('network'))) {
      console.warn(`[SVG] 生成失败，重试 ${retryCount + 1}/${maxRetries} - ${e.message}`);
      await new Promise(resolve => setTimeout(resolve, 1000)); // 等待1秒
      return generateSVG(description, subject, stem, retryCount + 1);
    }

    console.error(`[SVG] 生成失败 - ${e.message}`);
    return null;
  }
}

function ensureStyle(svg) {
  // 确保SVG有合适的显示样式，不裁剪
  const style = 'max-width:280px;height:auto;display:block;margin:8px auto;overflow:visible';
  if (!svg.includes('style=')) {
    return svg.replace('<svg', `<svg style="${style}"`);
  }
  return svg;
}

module.exports = router;
