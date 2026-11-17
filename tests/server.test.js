/**
 * tests/server.test.js
 * Kiểm thử tích hợp các endpoint HTTP của server.js
 */

const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

console.log('🧪 Bắt đầu kiểm thử tích hợp server.js...');

const nodeExe = process.execPath;
const serverScript = path.join(__dirname, '..', 'server.js');

const env = { ...process.env, PORT: '3456' };
const srv = spawn(nodeExe, [serverScript], { env, stdio: ['ignore', 'pipe', 'pipe'] });

srv.stdout.on('data', async (data) => {
  const text = data.toString();
  if (text.includes('3456')) {
    try {
      await testEndpoints();
      srv.kill();
      console.log('✅ Toàn bộ bài kiểm thử server.js đã PASS thành công!');
      process.exit(0);
    } catch (e) {
      srv.kill();
      console.error('❌ Kiểm thử server thất bại:', e);
      process.exit(1);
    }
  }
});

srv.stderr.on('data', (d) => {
  console.error('Server err:', d.toString());
});

function httpGet(pathStr) {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:3456${pathStr}`, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

function httpPost(pathStr, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(`http://localhost:3456${pathStr}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function testEndpoints() {
  // 1. Kiểm tra trang chủ GET /
  const rIndex = await httpGet('/');
  assert.strictEqual(rIndex.status, 200);
  assert.ok(rIndex.body.includes('Twitch'));

  // 2. Kiểm tra GET /api/system
  const rSys = await httpGet('/api/system');
  assert.strictEqual(rSys.status, 200);
  const sysJson = JSON.parse(rSys.body);
  assert.strictEqual(sysJson.status, 'ok');
  assert.strictEqual(sysJson.ffmpeg.installed, true);
  assert.ok(Array.isArray(sysJson.popularCategories));

  // 3. Kiểm tra GET /api/history
  const rHist = await httpGet('/api/history');
  assert.strictEqual(rHist.status, 200);
  assert.ok(Array.isArray(JSON.parse(rHist.body)));

  // 4. Kiểm tra POST /api/info với URL rỗng (Phải trả về 400)
  const rInfoErr = await httpPost('/api/info', {});
  assert.strictEqual(rInfoErr.status, 400);

  // 5. Kiểm tra POST /api/batch-download với danh sách rỗng (Phải trả về 400)
  const rBatchErr = await httpPost('/api/batch-download', { items: [] });
  assert.strictEqual(rBatchErr.status, 400);

  // 6. Kiểm tra POST /api/download với ràng buộc Min Duration vi phạm (Phải trả về 400)
  const rTrimErr = await httpPost('/api/download', {
    type: 'vod',
    subM3u8Url: 'https://example.com/stream.m3u8',
    isTrimEnabled: true,
    startTime: '00:00:00',
    endTime: '00:00:10', // 10 giây
    minDuration: '00:00:30' // yêu cầu tối thiểu 30 giây
  });
  assert.strictEqual(rTrimErr.status, 400);

  console.log('   ✓ GET / (Web UI HTML) -> 200 OK');
  console.log('   ✓ GET /api/system (FFmpeg status & categories) -> 200 OK');
  console.log('   ✓ GET /api/history (Task history) -> 200 OK');
  console.log('   ✓ POST /api/info (Error validation) -> 400 Bad Request');
  console.log('   ✓ POST /api/batch-download (Empty items validation) -> 400 Bad Request');
  console.log('   ✓ POST /api/download (Min/Max Duration Trim validation) -> 400 Bad Request');
}
