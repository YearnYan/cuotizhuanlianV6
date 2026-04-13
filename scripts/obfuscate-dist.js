const fs = require('fs');
const path = require('path');
const JavaScriptObfuscator = require('javascript-obfuscator');

const distDir = path.join(process.cwd(), 'dist', 'assets');

if (!fs.existsSync(distDir)) {
  console.error('未找到 dist/assets 目录，请先执行 npm run build');
  process.exit(1);
}

const files = fs.readdirSync(distDir).filter((name) => name.endsWith('.js'));

for (const file of files) {
  const fullPath = path.join(distDir, file);
  const code = fs.readFileSync(fullPath, 'utf8');

  const obfuscated = JavaScriptObfuscator.obfuscate(code, {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.2,
    deadCodeInjection: false,
    stringArray: true,
    stringArrayThreshold: 0.6,
    rotateStringArray: true,
    simplify: true,
    selfDefending: true,
    renameGlobals: false,
    debugProtection: false,
    sourceMap: false,
    unicodeEscapeSequence: false
  });

  fs.writeFileSync(fullPath, obfuscated.getObfuscatedCode(), 'utf8');
  console.log(`已混淆: ${file}`);
}
