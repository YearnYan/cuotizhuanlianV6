const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const projectRoot = process.cwd();
const srcDir = path.join(projectRoot, 'src');
const distDir = path.join(projectRoot, 'dist');
const assetsDir = path.join(distDir, 'assets');
const templatePath = path.join(srcDir, 'index.html');
const outputHtmlPath = path.join(distDir, 'index.html');
const entryPoint = path.join(srcDir, 'app-entry.js');

function removeLegacyTags(html) {
  let next = html.replace(
    /<link[^>]*href=["'][^"']*style\.css[^"']*["'][^>]*>\s*/gi,
    ''
  );
  next = next.replace(
    /<script[^>]*src=["'][^"']*app-entry\.js[^"']*["'][^>]*>\s*<\/script>\s*/gi,
    ''
  );
  return next;
}

function injectAssetTags(html, jsFile, cssFile) {
  const tags = [];
  if (cssFile) {
    tags.push(`  <link rel="stylesheet" crossorigin href="/assets/${cssFile}">`);
  }
  tags.push(`  <script type="module" crossorigin src="/assets/${jsFile}"></script>`);

  if (!html.includes('</head>')) {
    throw new Error('index.html 缺少 </head>，无法注入构建产物');
  }
  return html.replace('</head>', `${tags.join('\n')}\n</head>`);
}

function pickOutputAssets(metafile) {
  let jsFile = '';
  let cssFile = '';

  for (const [outputPath, outputInfo] of Object.entries(metafile.outputs || {})) {
    const fileName = path.basename(outputPath);
    const isEntry = outputInfo.entryPoint && path.resolve(outputInfo.entryPoint) === entryPoint;

    if (isEntry && fileName.endsWith('.js')) {
      jsFile = fileName;
    }
    if (isEntry && fileName.endsWith('.css')) {
      cssFile = fileName;
    }
  }

  if (!jsFile) {
    for (const outputPath of Object.keys(metafile.outputs || {})) {
      const fileName = path.basename(outputPath);
      if (fileName.endsWith('.js')) {
        jsFile = fileName;
        break;
      }
    }
  }

  if (!cssFile) {
    for (const outputPath of Object.keys(metafile.outputs || {})) {
      const fileName = path.basename(outputPath);
      if (fileName.endsWith('.css')) {
        cssFile = fileName;
        break;
      }
    }
  }

  if (!jsFile) {
    throw new Error('未找到 JS 构建产物');
  }

  return { jsFile, cssFile };
}

async function buildFrontend() {
  await fs.promises.rm(distDir, { recursive: true, force: true });
  await fs.promises.mkdir(assetsDir, { recursive: true });

  const buildResult = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'esm',
    target: ['es2019'],
    minify: true,
    sourcemap: false,
    splitting: false,
    outdir: assetsDir,
    entryNames: '[name]-[hash]',
    chunkNames: '[name]-[hash]',
    assetNames: '[name]-[hash]',
    metafile: true,
    logLevel: 'info',
    loader: {
      '.png': 'file',
      '.jpg': 'file',
      '.jpeg': 'file',
      '.webp': 'file',
      '.gif': 'file',
      '.svg': 'file',
      '.woff': 'file',
      '.woff2': 'file'
    }
  });

  const { jsFile, cssFile } = pickOutputAssets(buildResult.metafile);

  const templateHtml = await fs.promises.readFile(templatePath, 'utf8');
  const shellHtml = removeLegacyTags(templateHtml);
  const finalHtml = injectAssetTags(shellHtml, jsFile, cssFile);
  await fs.promises.writeFile(outputHtmlPath, finalHtml, 'utf8');

  console.log(`前端构建完成: /assets/${jsFile}${cssFile ? `, /assets/${cssFile}` : ''}`);
}

buildFrontend().catch((error) => {
  console.error('前端构建失败:', error.message);
  process.exit(1);
});
