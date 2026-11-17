/**
 * tests/twitch.test.js
 * Kiểm thử bộ phân tích URL Twitch, các hàm tiện ích thời gian và danh mục
 */

const assert = require('assert');
const {
  parseTwitchUrl,
  formatDuration,
  parseTimeToSeconds,
  searchTwitchVideosAndClips,
  POPULAR_CATEGORIES
} = require('../lib/twitch');

console.log('🧪 Bắt đầu kiểm thử lib/twitch.js...');

// 1. Kiểm thử URL VOD dạng số hoặc dạng link
const t1 = parseTwitchUrl('https://www.twitch.tv/videos/2930232350');
assert.strictEqual(t1.type, 'vod');
assert.strictEqual(t1.id, '2930232350');

const t2 = parseTwitchUrl('2930232350');
assert.strictEqual(t2.type, 'vod');
assert.strictEqual(t2.id, '2930232350');

// 2. Kiểm thử URL Clip các dạng
const t3 = parseTwitchUrl('https://clips.twitch.tv/SparklingBlazingAniseKeyboardCat-2996zL5kob_QF7xa');
assert.strictEqual(t3.type, 'clip');
assert.strictEqual(t3.slug, 'SparklingBlazingAniseKeyboardCat-2996zL5kob_QF7xa');

const t4 = parseTwitchUrl('https://www.twitch.tv/caseoh_/clip/SparklingBlazingAniseKeyboardCat-2996zL5kob_QF7xa');
assert.strictEqual(t4.type, 'clip');
assert.strictEqual(t4.slug, 'SparklingBlazingAniseKeyboardCat-2996zL5kob_QF7xa');

// 3. Kiểm thử kênh Channel
const t5 = parseTwitchUrl('https://www.twitch.tv/caseoh_');
assert.strictEqual(t5.type, 'channel');
assert.strictEqual(t5.login, 'caseoh_');

// 4. Kiểm thử hàm formatDuration
assert.strictEqual(formatDuration(45), '00:45');
assert.strictEqual(formatDuration(125), '02:05');
assert.strictEqual(formatDuration(3665), '01:01:05');

// 5. Kiểm thử hàm parseTimeToSeconds
assert.strictEqual(parseTimeToSeconds('00:01:30'), 90);
assert.strictEqual(parseTimeToSeconds('01:00:00'), 3600);
assert.strictEqual(parseTimeToSeconds('45'), 45);

// 6. Kiểm thử POPULAR_CATEGORIES
assert.ok(Array.isArray(POPULAR_CATEGORIES));
assert.ok(POPULAR_CATEGORIES.includes('Minecraft'));
assert.ok(POPULAR_CATEGORIES.includes('VALORANT'));

// 7. Kiểm thử hàm searchTwitchVideosAndClips
assert.strictEqual(typeof searchTwitchVideosAndClips, 'function');

console.log('✅ Toàn bộ bài kiểm thử lib/twitch.js đã PASS thành công!');
