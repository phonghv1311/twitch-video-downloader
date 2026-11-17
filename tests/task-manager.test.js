/**
 * tests/task-manager.test.js
 * Kiểm thử TaskManager (ghi đĩa an toàn, đọc metadata, quản lý lịch sử)
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { TaskManager } = require('../lib/task-manager');

console.log('🧪 Bắt đầu kiểm thử lib/task-manager.js...');

async function runTests() {
  const testDir = path.join(__dirname, 'temp_tasks');
  const tm = new TaskManager({ tasksDir: testDir });

  // 1. Tạo tác vụ mới
  const meta = await tm.createTask({
    type: 'vod',
    title: 'Test Stream Video',
    broadcaster: 'ProGamer',
    duration: 3600,
    format: 'mp4',
    qualityLabel: '1080p60'
  });

  assert.ok(meta.id.startsWith('twitch_'));
  assert.strictEqual(meta.title, 'Test Stream Video');
  assert.ok(meta.status === 'queued' || meta.status === 'downloading');

  // 2. Đọc metadata
  const readBack = await tm.readMetadata(meta.id);
  assert.ok(readBack);
  assert.strictEqual(readBack.broadcaster, 'ProGamer');

  // 3. Ghi cập nhật metadata
  readBack.percent = 50;
  readBack.status = 'downloading';
  await tm.writeMetadata(meta.id, readBack);

  const updated = await tm.readMetadata(meta.id);
  assert.strictEqual(updated.percent, 50);

  // 4. Lấy lịch sử
  const history = await tm.getTaskHistory();
  assert.ok(history.length >= 1);
  assert.strictEqual(history[0].id, meta.id);

  // 5. Xóa tác vụ
  await tm.deleteTask(meta.id);
  const deletedCheck = await tm.readMetadata(meta.id);
  assert.strictEqual(deletedCheck, null);

  // Dọn dẹp thư mục test
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  console.log('✅ Toàn bộ bài kiểm thử lib/task-manager.js đã PASS thành công!');
}

runTests().catch(err => {
  console.error('❌ Thất bại:', err);
  process.exit(1);
});
