#!/usr/bin/env node
/**
 * cli.js
 * Giao diện dòng lệnh (CLI) tải video Twitch VOD và Clip siêu tốc
 * Hỗ trợ cắt đoạn thời gian, chọn chất lượng và xuất MP4/MKV/MP3
 */

const path = require('path');
const fs = require('fs');
const { parseTwitchUrl, getClipInfo, getVodInfo, parseTimeToSeconds } = require('./lib/twitch');
const { globalTaskManager } = require('./lib/task-manager');
const { checkFfmpegInstalled } = require('./lib/ffmpeg');

function printBanner() {
  console.log('===============================================================');
  console.log('🎮  Twitch Video & Clip Downloader CLI');
  console.log('    Tải video tốc độ cao, cắt đoạn thời gian & không cần đăng nhập');
  console.log('===============================================================');
}

function printUsage() {
  console.log(`
Cách sử dụng:
  node cli.js <twitch-url> [tuỳ_chọn]

Ví dụ:
  # Tải Twitch Clip chất lượng gốc
  node cli.js "https://clips.twitch.tv/SparklingBlazingAniseKeyboardCat"

  # Tải Twitch VOD chất lượng 1080p60
  node cli.js "https://www.twitch.tv/videos/2930232350" -q 1080p60

  # Cắt đoạn từ phút 10 đến phút 20 và lưu thành highlight.mp4
  node cli.js "https://www.twitch.tv/videos/2930232350" --start 00:10:00 --end 00:20:00 -o highlight.mp4

  # Chỉ trích xuất file âm thanh MP3
  node cli.js "https://www.twitch.tv/videos/2930232350" --format mp3 -o audio.mp3

Các tuỳ chọn:
  -q, --quality <name>     Độ phân giải (VD: 1080p60, 720p60, 480p, audio_only)
  -s, --start <HH:MM:SS>   Thời gian bắt đầu cắt video (mặc định: từ đầu)
  -e, --end <HH:MM:SS>     Thời gian kết thúc cắt video (mặc định: đến hết)
  -f, --format <mp4|mkv|mp3> Định dạng xuất (mặc định: mp4)
  -o, --output <file>      Đường dẫn và tên file xuất mong muốn
  -c, --threads <number>   Số luồng tải song song (mặc định: 16, tối đa: 30)
  -h, --help               Hiển thị hướng dẫn này
`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    printBanner();
    printUsage();
    process.exit(0);
  }

  printBanner();

  const ffmpegCheck = checkFfmpegInstalled();
  if (!ffmpegCheck.installed) {
    console.warn('⚠️  Cảnh báo: Không tìm thấy FFmpeg trong hệ thống.');
    console.warn('    Khuyến nghị cài đặt FFmpeg để có thể ghép nối video VOD mượt mà nhất.\n');
  }

  const urlInput = args[0];
  let qualityOpt = null;
  let startOpt = null;
  let endOpt = null;
  let formatOpt = 'mp4';
  let outputOpt = null;
  let threadsOpt = 16;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-q' || arg === '--quality') qualityOpt = args[++i];
    else if (arg === '-s' || arg === '--start') startOpt = args[++i];
    else if (arg === '-e' || arg === '--end') endOpt = args[++i];
    else if (arg === '-f' || arg === '--format') formatOpt = args[++i].toLowerCase();
    else if (arg === '-o' || arg === '--output') outputOpt = args[++i];
    else if (arg === '-c' || arg === '--threads') threadsOpt = Math.min(Math.max(parseInt(args[++i], 10) || 16, 1), 30);
  }

  try {
    console.log(`🔍 Đang phân tích liên kết: ${urlInput}...`);
    const parsed = parseTwitchUrl(urlInput);

    if (parsed.type === 'clip') {
      const clip = await getClipInfo(parsed.slug);
      console.log(`\n📌 THÔNG TIN CLIP:`);
      console.log(`   Tiêu đề: ${clip.title}`);
      console.log(`   Streamer: ${clip.broadcaster}`);
      console.log(`   Game: ${clip.game}`);
      console.log(`   Thời lượng: ${clip.formattedDuration}`);
      console.log(`   Lượt xem: ${clip.viewCount.toLocaleString()}`);

      const chosenQuality = clip.qualities.find(q =>
        qualityOpt ? q.quality.includes(qualityOpt) || q.id.includes(qualityOpt) : q.isSource
      ) || clip.qualities[0];

      console.log(`\n⬇️  Chất lượng chọn: ${chosenQuality.label}`);
      console.log(`🚀 Bắt đầu tải Clip...`);

      const task = await globalTaskManager.createTask({
        type: 'clip',
        title: clip.title,
        broadcaster: clip.broadcaster,
        game: clip.game,
        thumbnailUrl: clip.thumbnailUrl,
        duration: clip.durationSeconds,
        format: formatOpt,
        qualityLabel: chosenQuality.label,
        downloadUrl: chosenQuality.url
      });

      await waitForTask(task.id, outputOpt);
    } else if (parsed.type === 'vod') {
      const vod = await getVodInfo(parsed.id);
      console.log(`\n📌 THÔNG TIN VIDEO VOD:`);
      console.log(`   Tiêu đề: ${vod.title}`);
      console.log(`   Streamer: ${vod.broadcaster}`);
      console.log(`   Game: ${vod.game}`);
      console.log(`   Tổng thời lượng: ${vod.formattedDuration}`);
      console.log(`   Lượt xem: ${vod.viewCount.toLocaleString()}`);

      console.log(`\nDanh sách chất lượng có sẵn:`);
      vod.qualities.forEach((q, idx) => {
        console.log(`   [${idx + 1}] ${q.label} ${q.resolution ? `(${q.resolution})` : ''}`);
      });

      let chosenQuality = vod.qualities[0];
      if (qualityOpt) {
        const found = vod.qualities.find(q =>
          q.id.toLowerCase().includes(qualityOpt.toLowerCase()) ||
          q.label.toLowerCase().includes(qualityOpt.toLowerCase())
        );
        if (found) chosenQuality = found;
      }

      console.log(`\n⬇️  Chất lượng được chọn: ${chosenQuality.label}`);
      if (startOpt || endOpt) {
        console.log(`✂️  Cắt thời gian: ${startOpt || '00:00:00'} ➔ ${endOpt || vod.formattedDuration}`);
      }

      const task = await globalTaskManager.createTask({
        type: 'vod',
        title: vod.title,
        broadcaster: vod.broadcaster,
        game: vod.game,
        thumbnailUrl: vod.thumbnailUrl,
        duration: vod.durationSeconds,
        format: formatOpt,
        qualityLabel: chosenQuality.label,
        subM3u8Url: chosenQuality.url,
        startTimeSec: parseTimeToSeconds(startOpt),
        endTimeSec: endOpt ? parseTimeToSeconds(endOpt) : null,
        concurrency: threadsOpt
      });

      await waitForTask(task.id, outputOpt);
    }
  } catch (err) {
    console.error(`\n❌ Lỗi: ${err.message}`);
    process.exit(1);
  }
}

async function waitForTask(taskId, targetOutputPath) {
  let lastPercent = -1;

  while (true) {
    await new Promise(r => setTimeout(r, 600));
    const meta = await globalTaskManager.readMetadata(taskId);
    if (!meta) continue;

    if (meta.percent !== lastPercent) {
      lastPercent = meta.percent;
      const speed = meta.speedMBs ? `${meta.speedMBs} MB/s` : '';
      const eta = meta.etaSeconds ? `(Còn ~${meta.etaSeconds}s)` : '';
      const segInfo = meta.totalSegments ? `[${meta.currentSegment || 0}/${meta.totalSegments}]` : '';
      process.stdout.write(`\r⏳ Tiến trình: ${meta.percent}% ${segInfo} ${speed} ${eta}    `);
    }

    if (meta.status === 'completed') {
      console.log(`\n\n🎉 Tải video hoàn tất thành công!`);
      const taskDir = globalTaskManager.getTaskDir(taskId);
      const generatedFile = path.join(taskDir, meta.finalFileName);

      if (targetOutputPath) {
        const resolvedTarget = path.resolve(targetOutputPath);
        fs.copyFileSync(generatedFile, resolvedTarget);
        console.log(`📁 File đã được lưu tới: ${resolvedTarget}`);
      } else {
        console.log(`📁 File video: ${generatedFile}`);
      }
      console.log(`📦 Kích thước: ${meta.fileSizeMB} MB`);
      break;
    }

    if (meta.status === 'failed' || meta.status === 'cancelled') {
      console.log(`\n\n❌ Tác vụ dừng lại: ${meta.error || 'Đã bị hủy'}`);
      break;
    }
  }
}

main();
