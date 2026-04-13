// 系统功能测试脚本
const http = require('http');

function testAPI(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 5000,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runTests() {
  console.log('=== 赛博出卷机系统测试 ===\n');

  // 测试1: 健康检查
  console.log('1. 测试健康检查API...');
  const health = await testAPI('/api/health');
  console.log(`   状态: ${health.status === 200 ? '✓' : '✗'} ${health.status}`);
  console.log(`   响应: ${JSON.stringify(health.data)}\n`);

  // 测试2: 获取教材版本列表
  console.log('2. 测试教材版本列表API...');
  const versions = await testAPI('/api/knowledge/versions');
  console.log(`   状态: ${versions.status === 200 ? '✓' : '✗'} ${versions.status}`);
  console.log(`   版本: ${JSON.stringify(versions.data)}\n`);

  // 测试3: 获取知识点（人教版小学一年级数学）
