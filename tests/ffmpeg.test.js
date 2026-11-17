/**
 * tests/ffmpeg.test.js
 * Kiểm thử việc nhận diện FFmpeg
 */

const assert = require('assert');
const { getFfmpegPath, checkFfmpegInstalled } = require('../lib/ffmpeg');

console.log('🧪 Bắt đầu kiểm thử lib/ffmpeg.js...');

const check = checkFfmpegInstalled();
console.log('FFmpeg check result:', check);

assert.ok(check.installed, 'FFmpeg phải được nhận diện thành công trên máy tính');
assert.ok(check.path, 'Phải có đường dẫn FFmpeg hợp lệ');
assert.ok(check.version && check.version.toLowerCase().includes('ffmpeg'), 'Version phải chứa ffmpeg');

console.log('✅ Toàn bộ bài kiểm thử lib/ffmpeg.js đã PASS thành công!');
