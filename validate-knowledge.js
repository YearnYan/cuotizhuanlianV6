#!/usr/bin/env node
// 知识库JSON文件验证工具

const fs = require('fs');
const path = require('path');

const knowledgeDir = path.join(__dirname, 'docs/教材知识点');

console.log('=== 知识库文件验证工具 ===\n');

// 获取所有JSON文件
const files = fs.readdirSync(knowledgeDir)
  .filter(f => f.endsWith('.json') && !f.includes('临时'));

console.log(`找到 ${files.length} 个知识库文件:\n`);

let totalValid = 0;
let totalInvalid = 0;

files.forEach(filename => {
  const filePath = path.join(knowledgeDir, filename);
  const stats = fs.statSync(filePath);

  process.stdout.write(`检查 ${filename} (${(stats.size/1024).toFixed(1)}KB)... `);

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(content);

    // 验证结构
    const topKeys = Object.keys(data);
    if (topKeys.length === 0) {
      console.log('❌ 空文件');
      totalInvalid++;
      return;
    }

    let gradeCount = 0;
    let subjectCount = 0;

    topKeys.forEach(versionKey => {
      if (typeof data[versionKey] === 'object' && !Array.isArray(data[versionKey])) {
        const grades = Object.keys(data[versionKey]);
        gradeCount += grades.length;

        grades.forEach(grade => {
          const subjects = Object.keys(data[versionKey][grade] || {});
          subjectCount += subjects.length;
        });
      }
    });

    console.log(`✅ 有效 (${gradeCount}个年级, ${subjectCount}个科目)`);
    totalValid++;

  } catch (e) {
    const errorMsg = e.message.substring(0, 60);
    console.log(`❌ 无效 - ${errorMsg}`);
    totalInvalid++;
  }
});

console.log(`\n总结: ${totalValid}个有效, ${totalInvalid}个无效\n`);

if (totalInvalid > 0) {
  console.log('⚠️  存在无效的知识库文件，请修复后再使用');
  process.exit(1);
} else {
  console.log('✅ 所有知识库文件格式正确');
  process.exit(0);
}
