/**
 * LaTeX渲染服务 - 主入口文件
 * 提供复杂图形的LaTeX编译和SVG生成服务
 */

const express = require('express');
const crypto = require('crypto');
const { exec } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

// ==================== 配置 ====================
const CONFIG = {
  PORT: process.env.PORT || 3001,
  LATEX_BIN: process.env.LATEX_BIN || 'latex',
  DVISVGM_BIN: process.env.DVISVGM_BIN || 'dvisvgm',
  CACHE_DIR: path.resolve(process.env.CACHE_DIR || './cache'),
  TMP_DIR: path.resolve(process.env.TMP_DIR || './tmp'),
  MAX_CONCURRENT: parseInt(process.env.MAX_CONCURRENT) || os.cpus().length,
  COMPILE_TIMEOUT: parseInt(process.env.COMPILE_TIMEOUT) || 10000,
  MEMORY_CACHE_MAX: parseInt(process.env.MEMORY_CACHE_MAX) || 256,
  MEMORY_CACHE_TTL: parseInt(process.env.MEMORY_CACHE_TTL) || 3600000,
  FILE_CACHE_TTL: parseInt(process.env.FILE_CACHE_TTL) || 604800000,
};

// ==================== 内存缓存（LRU） ====================
class LRUCache {
  constructor(maxSize = 256, ttl = 3600000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttl = ttl;
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return null;

    // 检查是否过期
    if (Date.now() - item.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }

    // LRU: 移到最后（最近使用）
    this.cache.delete(key);
    this.cache.set(key, item);
    return item.value;
  }

  set(key, value) {
    // 如果已存在，先删除
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // 淘汰最旧的条目
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, { value, timestamp: Date.now() });
  }

  get size() { return this.cache.size; }
}

// ==================== 并发控制 ====================
class ConcurrencyLimiter {
  constructor(maxConcurrent) {
    this.maxConcurrent = maxConcurrent;
    this.running = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return;
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release() {
    this.running--;
    if (this.queue.length > 0) {
      this.running++;
      const next = this.queue.shift();
      next();
    }
  }
}

// ==================== LaTeX模板注册表 ====================
const TEMPLATE_REGISTRY = {
  math: {
    geometry: {
      packages: ['tikz'],
      // 生成几何图形的TikZ代码
      generate: (params) => generateGeometryTikZ(params),
    },
    function: {
      packages: ['tikz', 'pgfplots'],
      generate: (params) => generateFunctionTikZ(params),
    },
    coordinate: {
      packages: ['tikz'],
      generate: (params) => generateCoordinateTikZ(params),
    },
    tree: {
      packages: ['tikz', 'forest'],
      generate: (params) => generateTreeTikZ(params),
    },
  },
  physics: {
    circuit: {
      packages: ['tikz', 'circuitikz'],
      generate: (params) => generateCircuitTikZ(params),
    },
    mechanics: {
      packages: ['tikz'],
      generate: (params) => generateMechanicsTikZ(params),
    },
    optics: {
      packages: ['tikz'],
      generate: (params) => generateOpticsTikZ(params),
    },
  },
  chemistry: {
    molecule: {
      packages: ['tikz', 'chemfig'],
      generate: (params) => generateMoleculeTikZ(params),
    },
    apparatus: {
      packages: ['tikz'],
      generate: (params) => generateApparatusTikZ(params),
    },
  },
};

// ==================== 模板生成函数（示例骨架） ====================

/**
 * 生成几何图形的TikZ代码
 * @param {Object} params - { points, segments, angles, labels, ... }
 * @returns {string} TikZ代码
 */
function generateGeometryTikZ(params) {
  const { points = [], segments = [], angles = [], labels = [] } = params;

  let tikz = '\\begin{tikzpicture}[scale=1]\n';

  // 绘制点
  points.forEach((p) => {
    tikz += `  \\coordinate (${p.name}) at (${p.x}, ${p.y});\n`;
  });

  // 绘制线段
  segments.forEach(([a, b]) => {
    tikz += `  \\draw (${a}) -- (${b});\n`;
  });

  // 绘制直角标记
  angles.filter((a) => a.type === 'right').forEach((a) => {
    tikz += `  \\draw (${a.vertex}) ++(0.3,0) -- ++(0,0.3) -- ++(-0.3,0);\n`;
  });

  // 标注点名
  points.forEach((p) => {
    const anchor = p.anchor || 'above';
    tikz += `  \\node[${anchor}] at (${p.name}) {$${p.name}$};\n`;
  });

  // 标注线段长度
  labels.forEach((l) => {
    tikz += `  \\node[midway, auto] at ($(${l.segment[0]})!0.5!(${l.segment[1]})$) {$${l.text}$};\n`;
  });

  tikz += '\\end{tikzpicture}';
  return tikz;
}

/**
 * 生成函数图像的TikZ代码（pgfplots）
 * @param {Object} params - { expression, xmin, xmax, ymin, ymax, ... }
 */
function generateFunctionTikZ(params) {
  const { expression, xmin = -5, xmax = 5, ymin = -5, ymax = 5, samples = 100 } = params;
  return `\\begin{tikzpicture}
  \\begin{axis}[
    axis lines=middle, xlabel=$x$, ylabel=$y$,
    xmin=${xmin}, xmax=${xmax}, ymin=${ymin}, ymax=${ymax},
    samples=${samples}, grid=major,
  ]
    \\addplot[blue, thick, domain=${xmin}:${xmax}] {${expression}};
  \\end{axis}
\\end{tikzpicture}`;
}

// 以下为其他模板的占位实现，按需扩展
function generateCoordinateTikZ(params) {
  // TODO: 实现坐标系/数轴图形生成
  return `\\begin{tikzpicture}
  \\draw[->] (-3,0) -- (3,0) node[right] {$x$};
  \\draw[->] (0,-3) -- (0,3) node[above] {$y$};
\\end{tikzpicture}`;
}

function generateTreeTikZ(params) {
  // TODO: 实现概率树形图生成
  return `\\begin{tikzpicture}[grow=right, level distance=2cm]
  \\node {Root} child { node {A} } child { node {B} };
\\end{tikzpicture}`;
}

function generateCircuitTikZ(params) {
  // TODO: 实现电路图生成
  return `\\begin{circuitikz}
  \\draw (0,0) to[R, l=$R_1$] (2,0) to[C, l=$C_1$] (4,0);
\\end{circuitikz}`;
}

function generateMechanicsTikZ(params) {
  // TODO: 实现力学示意图生成
  return `\\begin{tikzpicture}
  \\draw[fill=gray!30] (0,0) rectangle (2,1);
  \\draw[->, thick, red] (1,0.5) -- (3,0.5) node[right] {$F$};
\\end{tikzpicture}`;
}

function generateOpticsTikZ(params) {
  // TODO: 实现光路图生成
  return `\\begin{tikzpicture}
  \\draw[thick] (0,-1) -- (0,1);
  \\draw[->, red] (-2,0.5) -- (0,0) -- (2,-0.5);
\\end{tikzpicture}`;
}

function generateMoleculeTikZ(params) {
  // TODO: 实现分子结构图生成（chemfig）
  const { formula = 'H-C(-[2]H)(-[6]H)-H' } = params;
  return `\\chemfig{${formula}}`;
}

function generateApparatusTikZ(params) {
  // TODO: 实现实验装置图生成
  return `\\begin{tikzpicture}
  \\draw (0,0) -- (0,3) -- (1,3) -- (1,0) -- cycle;
  \\node at (0.5, 1.5) {烧杯};
\\end{tikzpicture}`;
}

// ==================== LaTeX编译核心 ====================

/**
 * 生成完整的LaTeX文档
 */
function buildLatexDocument(packages, tikzContent) {
  const pkgLines = packages.map((pkg) => {
    if (pkg === 'circuitikz') return '\\usepackage[siunitx]{circuitikz}';
    if (pkg === 'chemfig') return '\\usepackage{chemfig}';
    if (pkg === 'pgfplots') return '\\usepackage{pgfplots}\n\\pgfplotsset{compat=1.18}';
    if (pkg === 'forest') return '\\usepackage{forest}';
    if (pkg === 'tikz') return '\\usepackage{tikz}\n\\usetikzlibrary{calc,angles,quotes,positioning}';
    return `\\usepackage{${pkg}}`;
  }).join('\n');

  return `\\documentclass[tikz,border=2pt]{standalone}
\\usepackage[UTF8]{ctex}
${pkgLines}
\\begin{document}
${tikzContent}
\\end{document}`;
}

/**
 * 执行shell命令（Promise封装，带超时）
 */
function execAsync(cmd, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || CONFIG.COMPILE_TIMEOUT;
    const child = exec(cmd, { timeout, ...options }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Command failed: ${cmd}\n${stderr || error.message}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/**
 * 编译LaTeX为SVG
 * @param {string} latexSource - 完整的LaTeX文档源码
 * @returns {Promise<string>} SVG字符串
 */
async function compileLatexToSvg(latexSource) {
  // 创建临时工作目录
  const workDir = path.join(CONFIG.TMP_DIR, `render_${Date.now()}_${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(workDir, { recursive: true });

  const texFile = path.join(workDir, 'figure.tex');
  const dviFile = path.join(workDir, 'figure.dvi');
  const svgFile = path.join(workDir, 'figure.svg');

  try {
    // 写入.tex文件
    await fs.writeFile(texFile, latexSource, 'utf-8');

    // Step 1: latex → DVI
    await execAsync(
      `"${CONFIG.LATEX_BIN}" -interaction=nonstopmode -output-directory="${workDir}" "${texFile}"`,
      { cwd: workDir, timeout: CONFIG.COMPILE_TIMEOUT }
    );

    // Step 2: dvisvgm → SVG
    await execAsync(
      `"${CONFIG.DVISVGM_BIN}" --no-fonts --exact-bbox "${dviFile}" -o "${svgFile}"`,
      { cwd: workDir, timeout: CONFIG.COMPILE_TIMEOUT }
    );

    // 读取SVG内容
    const svgContent = await fs.readFile(svgFile, 'utf-8');
    return svgContent;
  } finally {
    // 异步清理临时目录（不阻塞返回）
    fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ==================== 缓存管理 ====================

const memoryCache = new LRUCache(CONFIG.MEMORY_CACHE_MAX, CONFIG.MEMORY_CACHE_TTL);
const limiter = new ConcurrencyLimiter(CONFIG.MAX_CONCURRENT);

/**
 * 生成缓存Key
 */
function generateCacheKey(subject, figureType, params) {
  const raw = `${subject}:${figureType}:${JSON.stringify(params)}`;
  return crypto.createHash('md5').update(raw).digest('hex');
}

/**
 * 从文件缓存读取SVG
 */
async function getFileCache(cacheKey) {
  const filePath = path.join(CONFIG.CACHE_DIR, `${cacheKey}.svg`);
  try {
    const stat = await fs.stat(filePath);
    // 检查是否过期
    if (Date.now() - stat.mtimeMs > CONFIG.FILE_CACHE_TTL) {
      await fs.unlink(filePath).catch(() => {});
      return null;
    }
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * 写入文件缓存
 */
async function setFileCache(cacheKey, svgContent) {
  await fs.mkdir(CONFIG.CACHE_DIR, { recursive: true });
  const filePath = path.join(CONFIG.CACHE_DIR, `${cacheKey}.svg`);
  await fs.writeFile(filePath, svgContent, 'utf-8');
}

// ==================== 核心渲染函数 ====================

/**
 * 渲染图形（带缓存和并发控制）
 */
async function renderFigure(subject, figureType, params) {
  const cacheKey = generateCacheKey(subject, figureType, params);
  const startTime = Date.now();

  // L1: 内存缓存
  const memoryCached = memoryCache.get(cacheKey);
  if (memoryCached) {
    return { svg: memoryCached, cacheKey, cached: true, renderTime: Date.now() - startTime };
  }

  // L2: 文件缓存
  const fileCached = await getFileCache(cacheKey);
  if (fileCached) {
    memoryCache.set(cacheKey, fileCached);
    return { svg: fileCached, cacheKey, cached: true, renderTime: Date.now() - startTime };
  }

  // 查找模板
  const template = TEMPLATE_REGISTRY[subject]?.[figureType];
  if (!template) {
    throw Object.assign(new Error(`Template not found: ${subject}/${figureType}`), { code: 'TEMPLATE_NOT_FOUND' });
  }

  // 并发控制
  await limiter.acquire();
  try {
    // 生成TikZ代码
    const tikzContent = template.generate(params);

    // 构建完整LaTeX文档
    const latexSource = buildLatexDocument(template.packages, tikzContent);

    // 编译为SVG
    const svgContent = await compileLatexToSvg(latexSource);

    // 写入缓存
    memoryCache.set(cacheKey, svgContent);
    setFileCache(cacheKey, svgContent).catch((err) => {
      console.error('File cache write error:', err.message);
    });

    return { svg: svgContent, cacheKey, cached: false, renderTime: Date.now() - startTime };
  } finally {
    limiter.release();
  }
}

// ==================== Express应用 ====================

const app = express();
app.use(express.json({ limit: '1mb' }));

// CORS支持
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// 静态SVG文件服务
app.use('/static/figures', express.static(CONFIG.CACHE_DIR));

// ---- POST /api/render-figure ----
app.post('/api/render-figure', async (req, res) => {
  const { subject, figureType, description, params = {}, options = {} } = req.body;

  // 参数校验
  if (!subject || !figureType) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_PARAMS', message: 'subject and figureType are required' },
    });
  }

  try {
    const result = await renderFigure(subject, figureType, params);
    const response = {
      success: true,
      data: {
        svg: options.format === 'url' ? undefined : result.svg,
        url: `/static/figures/${result.cacheKey}.svg`,
        cacheKey: result.cacheKey,
        cached: result.cached,
        renderTime: result.renderTime,
      },
    };
    res.json(response);
  } catch (err) {
    console.error(`Render error [${subject}/${figureType}]:`, err.message);
    const statusCode = err.code === 'TEMPLATE_NOT_FOUND' ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      error: {
        code: err.code || 'RENDER_FAILED',
        message: err.message,
      },
      fallback: {
        type: 'placeholder',
        description: description || `${subject}/${figureType} figure`,
      },
    });
  }
});

// ---- POST /api/render-figures/batch ----
app.post('/api/render-figures/batch', async (req, res) => {
  const { figures = [], options = {} } = req.body;
  const concurrent = Math.min(options.concurrent || 3, CONFIG.MAX_CONCURRENT);

  if (!Array.isArray(figures) || figures.length === 0) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_PARAMS', message: 'figures array is required' },
    });
  }

  const startTime = Date.now();
  const results = [];

  // 分批并行渲染
  for (let i = 0; i < figures.length; i += concurrent) {
    const batch = figures.slice(i, i + concurrent);
    const batchResults = await Promise.allSettled(
      batch.map((fig) => renderFigure(fig.subject, fig.figureType, fig.params || {}))
    );

    batchResults.forEach((result, idx) => {
      const fig = batch[idx];
      if (result.status === 'fulfilled') {
        results.push({
          id: fig.id,
          success: true,
          url: `/static/figures/${result.value.cacheKey}.svg`,
          cached: result.value.cached,
        });
      } else {
        results.push({
          id: fig.id,
          success: false,
          error: { code: result.reason?.code || 'RENDER_FAILED', message: result.reason?.message },
        });
      }
    });
  }

  const succeeded = results.filter((r) => r.success).length;
  res.json({
    success: true,
    results,
    stats: { total: figures.length, succeeded, failed: figures.length - succeeded, totalTime: Date.now() - startTime },
  });
});

// ---- GET /api/render-figure/cache/:cacheKey ----
app.get('/api/render-figure/cache/:cacheKey', async (req, res) => {
  const { cacheKey } = req.params;

  // 安全校验：cacheKey只允许十六进制字符
  if (!/^[a-f0-9]{32}$/.test(cacheKey)) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_CACHE_KEY' } });
  }

  // 先查内存缓存
  const memoryCached = memoryCache.get(cacheKey);
  if (memoryCached) {
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.send(memoryCached);
  }

  // 再查文件缓存
  const filePath = path.join(CONFIG.CACHE_DIR, `${cacheKey}.svg`);
  try {
    const svg = await fs.readFile(filePath, 'utf-8');
    memoryCache.set(cacheKey, svg);
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
  } catch {
    res.status(404).json({ success: false, error: { code: 'CACHE_NOT_FOUND' } });
  }
});

// ---- GET /api/render-figure/health ----
app.get('/api/render-figure/health', async (req, res) => {
  // 检查latex和dvisvgm是否可用
  let latexInfo = { available: false };
  let dvisvgmInfo = { available: false };

  try {
    const { stdout } = await execAsync(`"${CONFIG.LATEX_BIN}" --version`, { timeout: 5000 });
    latexInfo = { available: true, version: stdout.split('\n')[0] };
  } catch { /* unavailable */ }

  try {
    const { stdout } = await execAsync(`"${CONFIG.DVISVGM_BIN}" --version`, { timeout: 5000 });
    dvisvgmInfo = { available: true, version: stdout.split('\n')[0] };
  } catch { /* unavailable */ }

  // 统计文件缓存
  let diskFiles = 0;
  try {
    const files = await fs.readdir(CONFIG.CACHE_DIR);
    diskFiles = files.filter((f) => f.endsWith('.svg')).length;
  } catch { /* dir may not exist */ }

  res.json({
    status: latexInfo.available ? 'ok' : 'degraded',
    latex: latexInfo,
    dvisvgm: dvisvgmInfo,
    cache: { memoryEntries: memoryCache.size, diskFiles },
    concurrency: { running: limiter.running, queued: limiter.queue.length, max: CONFIG.MAX_CONCURRENT },
  });
});

// ==================== 启动服务 ====================

async function start() {
  // 确保必要目录存在
  await fs.mkdir(CONFIG.CACHE_DIR, { recursive: true });
  await fs.mkdir(CONFIG.TMP_DIR, { recursive: true });

  app.listen(CONFIG.PORT, () => {
    console.log(`LaTeX Render Service running on port ${CONFIG.PORT}`);
    console.log(`  Cache dir: ${CONFIG.CACHE_DIR}`);
    console.log(`  Tmp dir:   ${CONFIG.TMP_DIR}`);
    console.log(`  Max concurrent: ${CONFIG.MAX_CONCURRENT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start LaTeX render service:', err);
  process.exit(1);
});

module.exports = { app, renderFigure, TEMPLATE_REGISTRY };
