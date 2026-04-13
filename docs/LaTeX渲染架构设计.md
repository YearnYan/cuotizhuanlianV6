# LaTeX渲染架构设计文档

## 1. 整体架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                          前端应用层                              │
│  ┌──────────────────┐         ┌──────────────────────────┐     │
│  │  KaTeX/MathJax   │         │   SVG图形展示组件         │     │
│  │  (纯文本公式)     │         │   (复杂图形)              │     │
│  └────────┬─────────┘         └──────────┬───────────────┘     │
│           │                              │                      │
└───────────┼──────────────────────────────┼──────────────────────┘
            │                              │
            │ 接收题目数据                  │ 请求SVG图形
            │ (含公式字符串)                │ POST /api/render-figure
            │                              │
┌───────────┴──────────────────────────────┴──────────────────────┐
│                        API网关层                                 │
│                   (Express + 路由分发)                           │
└───────────┬──────────────────────────────┬──────────────────────┘
            │                              │
            │ 题目数据查询                  │ 图形渲染请求
            │                              │
┌───────────┴─────────┐      ┌─────────────┴────────────────────┐
│   题目数据服务       │      │    LaTeX渲染服务                  │
│   (MongoDB/MySQL)   │      │    (Node.js + LaTeX)             │
│                     │      │                                   │
│  - 题目文本         │      │  ┌─────────────────────────────┐ │
│  - 公式字符串       │      │  │  缓存层 (Memory + Redis)    │ │
│  - 图形描述参数     │      │  │  - MD5哈希检查              │ │
└─────────────────────┘      │  │  - 命中返回缓存SVG          │ │
                             │  └─────────────────────────────┘ │
                             │  ┌─────────────────────────────┐ │
                             │  │  LaTeX模板引擎              │ │
                             │  │  - 数学图形 (TikZ)          │ │
                             │  │  - 电路图 (circuitikz)      │ │
                             │  │  - 化学结构 (chemfig)       │ │
                             │  │  - 函数图像 (pgfplots)      │ │
                             │  └─────────────────────────────┘ │
                             │  ┌─────────────────────────────┐ │
                             │  │  LaTeX编译器                │ │
                             │  │  latex → dvisvgm → SVG      │ │
                             │  └─────────────────────────────┘ │
                             │  ┌─────────────────────────────┐ │
                             │  │  SVG优化与存储              │ │
                             │  │  - SVGO压缩                 │ │
                             │  │  - 文件系统/CDN             │ │
                             │  └─────────────────────────────┘ │
                             └───────────────────────────────────┘
```

## 2. 前端渲染方案详细设计

### 2.1 技术选型

**KaTeX（推荐）**
- 优势：渲染速度快（无需重排），体积小（~100KB），支持SSR
- 适用场景：数学公式、化学方程式（mhchem扩展）
- 集成方式：
  ```javascript
  import katex from 'katex';
  import 'katex/dist/katex.min.css';

  katex.render(latexString, element, {
    throwOnError: false,
    displayMode: true
  });
  ```

**MathJax（备选）**
- 优势：兼容性好，支持更多LaTeX语法
- 劣势：体积大（~500KB），渲染较慢

### 2.2 渲染分类策略

前端根据题目数据中的字段类型决定渲染方式：

| 内容类型 | 渲染方式 | 示例 |
|---------|---------|------|
| 纯文本 | 直接展示 | "已知三角形ABC..." |
| 行内公式 | KaTeX inline | `$x^2 + y^2 = r^2$` |
| 块级公式 | KaTeX display | `$$\int_0^1 f(x)dx$$` |
| 化学方程式 | KaTeX + mhchem | `$\ce{2H2 + O2 -> 2H2O}$` |
| 复杂图形 | 后端SVG | `{ figureType: "geometry", ... }` |

### 2.3 前端渲染组件设计

```javascript
// 题目内容渲染器 - 根据内容类型分发渲染
function QuestionRenderer({ content }) {
  return content.map((block, i) => {
    switch (block.type) {
      case 'text':     return <TextBlock key={i} text={block.value} />;
      case 'formula':  return <FormulaBlock key={i} latex={block.value} display={block.display} />;
      case 'figure':   return <FigureBlock key={i} figureId={block.figureId} params={block.params} />;
      default:         return null;
    }
  });
}

// FormulaBlock: KaTeX渲染纯文本公式
// FigureBlock: 请求后端SVG或从缓存加载
```

### 2.4 KaTeX扩展配置

```javascript
const katexOptions = {
  throwOnError: false,
  errorColor: '#cc0000',
  macros: {
    '\\R': '\\mathbb{R}',
    '\\N': '\\mathbb{N}',
    '\\Z': '\\mathbb{Z}',
    '\\vec': '\\overrightarrow',
  },
  trust: true,
  strict: false,
};
// mhchem扩展需额外引入: import 'katex/contrib/mhchem';
```

## 3. 后端渲染方案详细设计

### 3.1 渲染流程

```
请求到达 → 参数校验 → 生成缓存Key(MD5)
    ↓
缓存命中? ─── 是 ──→ 返回缓存SVG
    │ 否
    ↓
选择LaTeX模板 → 填充参数 → 生成.tex文件
    ↓
latex编译 → .dvi文件 → dvisvgm转换 → .svg文件
    ↓
SVGO优化 → 写入缓存 → 返回SVG
```

### 3.2 支持的图形类型

| 科目 | 图形类型 | LaTeX宏包 | 模板文件 |
|------|---------|-----------|---------|
| 数学 | 几何图形 | TikZ | `templates/math/geometry.tex` |
| 数学 | 函数图像 | pgfplots | `templates/math/function.tex` |
| 数学 | 数轴/坐标系 | TikZ | `templates/math/coordinate.tex` |
| 数学 | 概率树形图 | TikZ/forest | `templates/math/tree.tex` |
| 物理 | 电路图 | circuitikz | `templates/physics/circuit.tex` |
| 物理 | 力学示意图 | TikZ | `templates/physics/mechanics.tex` |
| 物理 | 光路图 | TikZ | `templates/physics/optics.tex` |
| 化学 | 分子结构 | chemfig | `templates/chemistry/molecule.tex` |
| 化学 | 实验装置 | TikZ | `templates/chemistry/apparatus.tex` |

### 3.3 LaTeX模板引擎

模板采用分层设计：

```
templates/
├── base.tex              # 基础文档模板（documentclass, 公共宏包）
├── math/
│   ├── geometry.tex      # 几何图形模板
│   ├── function.tex      # 函数图像模板
│   └── coordinate.tex    # 坐标系模板
├── physics/
│   ├── circuit.tex       # 电路图模板
│   ├── mechanics.tex     # 力学图模板
│   └── optics.tex        # 光路图模板
└── chemistry/
    ├── molecule.tex      # 分子结构模板
    └── apparatus.tex     # 实验装置模板
```

**base.tex 模板结构：**
```latex
\documentclass[tikz,border=2pt]{standalone}
%%PACKAGES%%
\begin{document}
%%CONTENT%%
\end{document}
```

### 3.4 编译工具链

```
latex (TeX Live) → DVI → dvisvgm → SVG → SVGO → 优化SVG
```

- `latex`：编译.tex为.dvi（比pdflatex更适合SVG转换）
- `dvisvgm`：DVI转SVG，支持字体嵌入和路径转换
- `svgo`：SVG优化压缩，去除冗余属性

备选编译路径（当dvisvgm不可用时）：
```
pdflatex → PDF → pdf2svg → SVG
```

## 4. API接口设计

### 4.1 图形渲染接口

**POST /api/render-figure**

请求体：
```json
{
  "subject": "math",
  "figureType": "geometry",
  "description": "直角三角形ABC，角C=90度，AB=5，BC=3",
  "params": {
    "points": [
      { "name": "A", "x": 0, "y": 4 },
      { "name": "B", "x": 3, "y": 0 },
      { "name": "C", "x": 0, "y": 0 }
    ],
    "segments": [["A","B"], ["B","C"], ["C","A"]],
    "angles": [{ "vertex": "C", "type": "right" }],
    "labels": [{ "segment": ["A","B"], "text": "5" }]
  },
  "options": {
    "width": 300,
    "format": "svg_string"
  }
}
```

响应体（成功）：
```json
{
  "success": true,
  "data": {
    "svg": "<svg xmlns='...' ...>...</svg>",
    "url": "/static/figures/a1b2c3d4.svg",
    "cacheKey": "a1b2c3d4e5f6",
    "cached": false,
    "renderTime": 1200
  }
}
```

响应体（失败）：
```json
{
  "success": false,
  "error": {
    "code": "RENDER_FAILED",
    "message": "LaTeX compilation error",
    "detail": "Undefined control sequence \\badcommand"
  },
  "fallback": {
    "type": "placeholder",
    "description": "直角三角形ABC，角C=90度"
  }
}
```

### 4.2 批量渲染接口

**POST /api/render-figures/batch**

请求体：
```json
{
  "figures": [
    { "id": "fig1", "subject": "math", "figureType": "geometry", "params": {} },
    { "id": "fig2", "subject": "physics", "figureType": "circuit", "params": {} }
  ],
  "options": { "format": "url", "concurrent": 3 }
}
```

响应体：
```json
{
  "success": true,
  "results": [
    { "id": "fig1", "success": true, "url": "/static/figures/xxx.svg" },
    { "id": "fig2", "success": false, "error": { "code": "TEMPLATE_NOT_FOUND" } }
  ],
  "stats": { "total": 2, "succeeded": 1, "failed": 1, "totalTime": 2400 }
}
```

### 4.3 缓存查询接口

**GET /api/render-figure/cache/:cacheKey**

直接返回已缓存的SVG文件，用于前端二次加载。

### 4.4 健康检查接口

**GET /api/render-figure/health**

```json
{
  "status": "ok",
  "latex": { "available": true, "version": "TeX Live 2024" },
  "dvisvgm": { "available": true, "version": "3.1" },
  "cache": { "memoryEntries": 128, "diskFiles": 1024, "diskSize": "45MB" }
}
```

## 5. 缓存策略

### 5.1 三级缓存架构

```
L1: 内存缓存 (LRU, 最近256个SVG)
    ↓ 未命中
L2: Redis缓存 (可选, 分布式场景)
    ↓ 未命中
L3: 文件系统缓存 (磁盘, 持久化)
    ↓ 未命中
    执行LaTeX编译
```

### 5.2 缓存Key生成

```javascript
// 缓存Key = MD5(subject + figureType + JSON.stringify(params))
// 相同参数的图形请求一定命中缓存，避免重复编译
const cacheKey = crypto
  .createHash('md5')
  .update(`${subject}:${figureType}:${JSON.stringify(params)}`)
  .digest('hex');
```

### 5.3 缓存淘汰策略

| 缓存层 | 容量限制 | 淘汰策略 | TTL |
|--------|---------|---------|-----|
| L1 内存 | 256条 / 50MB | LRU | 1小时 |
| L2 Redis | 10000条 | LRU + TTL | 24小时 |
| L3 文件 | 1GB | 按访问时间清理 | 7天 |

### 5.4 缓存预热

- 高频题目的图形在系统启动时预渲染
- 新试卷生成后，异步预渲染所有图形
- 定时任务清理过期缓存文件

## 6. 错误处理和降级方案

### 6.1 错误分类

| 错误类型 | 错误码 | 处理方式 |
|---------|--------|---------|
| 参数校验失败 | `INVALID_PARAMS` | 返回400，提示具体字段错误 |
| 模板不存在 | `TEMPLATE_NOT_FOUND` | 返回404，降级为文字描述 |
| LaTeX编译失败 | `LATEX_COMPILE_ERROR` | 返回500，返回编译错误日志 |
| dvisvgm转换失败 | `SVG_CONVERT_ERROR` | 返回500，尝试备选编译路径 |
| 编译超时 | `RENDER_TIMEOUT` | 返回504，终止子进程 |
| 系统资源不足 | `SYSTEM_OVERLOAD` | 返回503，进入排队 |

### 6.2 降级策略

```
Level 0: 正常渲染SVG
    ↓ 失败
Level 1: 尝试备选编译路径 (pdflatex → pdf2svg)
    ↓ 失败
Level 2: 返回预置的通用占位图 + 文字描述
    ↓ 失败
Level 3: 返回纯文字描述（"如图所示：直角三角形ABC..."）
```

### 6.3 超时控制

- 单次LaTeX编译超时：10秒
- 单次请求总超时：15秒
- 批量请求总超时：60秒
- 超时后强制kill子进程，清理临时文件

### 6.4 并发控制

- 最大并发编译数：CPU核心数（默认4）
- 超出并发限制的请求进入队列等待
- 队列满时返回503，建议客户端重试

## 7. 性能优化策略

### 7.1 编译性能优化

- **LaTeX格式预编译**：使用 `fmtutil` 预编译常用宏包为 `.fmt` 格式文件，减少每次编译的宏包加载时间（从~2s降至~0.5s）
- **临时目录复用**：为每个编译任务创建独立临时目录，编译完成后异步清理
- **并行编译**：批量请求中的多个图形并行编译，受并发数限制
- **增量编译**：对于仅参数变化的同类图形，复用辅助文件（.aux）

### 7.2 SVG优化

- SVGO配置：移除注释、元数据、编辑器标记
- 字体转路径：`dvisvgm --font-format=woff2` 或 `--no-fonts`（转为路径）
- 压缩：gzip压缩SVG（.svgz），减少传输体积60-80%

### 7.3 前端优化

- **懒加载**：图形进入视口时才请求渲染
- **预加载**：试卷生成后立即触发所有图形的预渲染
- **SVG内联**：小图形直接内联到HTML，减少HTTP请求
- **Service Worker缓存**：已加载的SVG图形缓存到浏览器

### 7.4 系统级优化

- **Worker Pool**：使用 `worker_threads` 或子进程池管理编译任务
- **内存限制**：每个LaTeX编译进程限制内存使用（ulimit）
- **磁盘IO**：临时文件使用tmpfs（内存文件系统）
- **监控告警**：编译耗时、队列长度、缓存命中率的实时监控

## 8. 部署方案

### 8.1 Docker部署（推荐）

```dockerfile
FROM node:20-slim

# 安装TeX Live（精简版，仅包含需要的宏包）
RUN apt-get update && apt-get install -y \
    texlive-base \
    texlive-latex-extra \
    texlive-pictures \
    texlive-science \
    dvisvgm \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .

# 创建缓存和临时目录
RUN mkdir -p /app/cache /app/tmp

EXPOSE 3001
CMD ["node", "index.js"]
```

### 8.2 目录结构

```
server/latex-renderer/
├── index.js                 # 入口文件，Express服务
├── package.json
├── config.js                # 配置文件
├── routes/
│   └── render.js            # 路由定义
├── services/
│   ├── compiler.js          # LaTeX编译服务
│   ├── cache.js             # 缓存管理
│   ├── template-engine.js   # 模板引擎
│   └── svg-optimizer.js     # SVG优化
├── templates/               # LaTeX模板
│   ├── base.tex
│   ├── math/
│   ├── physics/
│   └── chemistry/
├── cache/                   # 文件缓存目录
├── tmp/                     # 编译临时目录
└── Dockerfile
```

### 8.3 环境变量配置

```bash
PORT=3001                          # 服务端口
LATEX_BIN=/usr/bin/latex            # latex可执行文件路径
DVISVGM_BIN=/usr/bin/dvisvgm       # dvisvgm可执行文件路径
CACHE_DIR=./cache                   # 文件缓存目录
TMP_DIR=./tmp                       # 临时文件目录
MAX_CONCURRENT=4                    # 最大并发编译数
COMPILE_TIMEOUT=10000               # 编译超时(ms)
MEMORY_CACHE_MAX=256                # 内存缓存最大条目
MEMORY_CACHE_TTL=3600000            # 内存缓存TTL(ms)
FILE_CACHE_MAX_SIZE=1073741824      # 文件缓存最大体积(1GB)
FILE_CACHE_TTL=604800000            # 文件缓存TTL(7天)
```

### 8.4 生产环境架构

```
                    ┌──────────┐
                    │  Nginx   │
                    │  (反向代理 + 静态SVG)
                    └────┬─────┘
                         │
              ┌──────────┼──────────┐
              │          │          │
         ┌────┴───┐ ┌───┴────┐ ┌──┴─────┐
         │ Node 1 │ │ Node 2 │ │ Node 3 │
         │ :3001  │ │ :3002  │ │ :3003  │
         └────┬───┘ └───┬────┘ └──┬─────┘
              │         │         │
              └─────────┼─────────┘
                        │
                   ┌────┴────┐
                   │  Redis  │ (共享缓存)
                   └─────────┘
```

- Nginx负责负载均衡和静态SVG文件分发
- 多Node实例水平扩展，共享Redis缓存
- 每个Node实例有独立的L1内存缓存
- 静态SVG文件可进一步推送到CDN
