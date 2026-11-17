/**
 * lib/ffmpeg.js
 * Quản lý định vị và thực thi FFmpeg để ghép nối (remux) các phân đoạn .ts thành file MP4/MKV/MP3
 * Tối ưu hóa đặc biệt cho CapCut (tỷ lệ 16:9, chuẩn màu yuv420p, faststart metadata và 2 mức phân giải 1080p / 2K).
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

let cachedFfmpegPath = null;

const COMMON_FFMPEG_PATHS = [
  'C:\\Users\\phong\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin\\ffmpeg.exe',
  'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
  'C:\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe'
];

function getFfmpegPath() {
  if (cachedFfmpegPath) return cachedFfmpegPath;

  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    cachedFfmpegPath = process.env.FFMPEG_PATH;
    return cachedFfmpegPath;
  }

  try {
    const isWindows = process.platform === 'win32';
    const checkCmd = isWindows ? 'where ffmpeg' : 'which ffmpeg';
    const output = execSync(checkCmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (output) {
      const firstLine = output.split(/[\r\n]+/)[0].trim();
      if (fs.existsSync(firstLine)) {
        cachedFfmpegPath = firstLine;
        return cachedFfmpegPath;
      }
    }
  } catch (e) {}

  for (const candidate of COMMON_FFMPEG_PATHS) {
    if (fs.existsSync(candidate)) {
      cachedFfmpegPath = candidate;
      return cachedFfmpegPath;
    }
  }

  return 'ffmpeg';
}

function checkFfmpegInstalled() {
  try {
    const ffmpegPath = getFfmpegPath();
    const output = execSync(`"${ffmpegPath}" -version`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return {
      installed: true,
      path: ffmpegPath,
      version: output.split('\n')[0]
    };
  } catch (e) {
    return {
      installed: false,
      path: null,
      error: e.message
    };
  }
}

/**
 * Ghép nối các phân đoạn .ts thành file hoàn chỉnh
 * Hỗ trợ chuẩn CapCut (16:9, H.264, AAC 48kHz, FastStart) và 2 mức phân giải 1080p / 2K
 */
function remuxSegments({
  concatListPath,
  outputPath,
  format = 'mp4',
  resolution = '1080p', // '1080p' hoặc '2k'
  onLog,
  signal
}) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = getFfmpegPath();
    const args = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath
    ];

    if (format === 'mp3') {
      args.push('-vn', '-acodec', 'libmp3lame', '-q:a', '2');
    } else if (format === 'm4a') {
      args.push('-vn', '-c:a', 'copy');
    } else if (format === 'mkv') {
      args.push('-c', 'copy');
    } else {
      // Định dạng MP4 tối ưu hóa cho CapCut
      if (resolution === '2k') {
        // Xuất chuẩn 2K QHD 2560x1440 tỷ lệ 16:9 chuẩn màu yuv420p
        if (onLog) onLog('Áp dụng bộ lọc chất lượng cao Lanczos xuất chuẩn 2K QHD (2560x1440, 16:9) cho CapCut...');
        args.push(
          '-vf', 'scale=2560:1440:flags=lanczos,setdar=16/9,format=yuv420p',
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-crf', '18',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-ar', '48000',
          '-movflags', '+faststart'
        );
      } else {
        // Chuẩn 1080p Full HD (1920x1080, 16:9) Direct Stream Copy siêu tốc cho CapCut
        args.push(
          '-c', 'copy',
          '-bsf:a', 'aac_adtstoasc',
          '-movflags', '+faststart'
        );
      }
    }

    args.push(outputPath);

    if (onLog) {
      onLog(`Khởi chạy FFmpeg: ${ffmpegPath} ${args.join(' ')}`);
    }

    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrData = '';

    proc.stdout.on('data', chunk => {
      const text = chunk.toString();
      if (onLog) onLog(text.trim());
    });

    proc.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderrData += text;
      const lines = text.split(/[\r\n]+/);
      for (const line of lines) {
        if (line.includes('time=') || line.includes('size=')) {
          if (onLog) onLog(line.trim());
        }
      }
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        try { proc.kill('SIGKILL'); } catch (e) {}
        reject(new Error('Tác vụ FFmpeg đã bị hủy'));
      });
    }

    proc.on('close', code => {
      if (code === 0) {
        if (onLog) onLog(`FFmpeg xử lý thành công! File xuất: ${outputPath}`);
        resolve(outputPath);
      } else {
        const errorMsg = `FFmpeg kết thúc với mã lỗi ${code}. Chi tiết: ${stderrData.slice(-500)}`;
        if (onLog) onLog(errorMsg);
        reject(new Error(errorMsg));
      }
    });

    proc.on('error', err => {
      if (onLog) onLog(`Lỗi khi khởi chạy FFmpeg: ${err.message}`);
      reject(err);
    });
  });
}

/**
 * Chuyển đổi file Clip sang định dạng tối ưu CapCut (1080p hoặc 2K)
 */
function convertClipFile({
  inputPath,
  outputPath,
  format = 'mp4',
  resolution = '1080p',
  onLog,
  signal
}) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = getFfmpegPath();
    const args = ['-y', '-i', inputPath];

    if (format === 'mp3') {
      args.push('-vn', '-acodec', 'libmp3lame', '-q:a', '2');
    } else if (format === 'm4a') {
      args.push('-vn', '-c:a', 'copy');
    } else if (format === 'mkv') {
      args.push('-c', 'copy');
    } else {
      if (resolution === '2k') {
        if (onLog) onLog('Nâng cấp độ phân giải Clip lên 2K QHD (2560x1440, 16:9) cho CapCut...');
        args.push(
          '-vf', 'scale=2560:1440:flags=lanczos,setdar=16/9,format=yuv420p',
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-crf', '18',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-ar', '48000',
          '-movflags', '+faststart'
        );
      } else {
        // Giữ chuẩn 1080p Full HD với faststart cho CapCut
        args.push('-c', 'copy', '-movflags', '+faststart');
      }
    }

    args.push(outputPath);

    if (onLog) onLog(`Chuyển đổi Clip: ${ffmpegPath} ${args.join(' ')}`);

    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';

    proc.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        try { proc.kill('SIGKILL'); } catch (e) {}
        reject(new Error('Đã hủy chuyển đổi Clip'));
      });
    }

    proc.on('close', code => {
      if (code === 0) resolve(outputPath);
      else reject(new Error(`Lỗi chuyển đổi Clip (${code}): ${stderr.slice(-300)}`));
    });

    proc.on('error', reject);
  });
}

module.exports = {
  getFfmpegPath,
  checkFfmpegInstalled,
  remuxSegments,
  convertClipFile
};
