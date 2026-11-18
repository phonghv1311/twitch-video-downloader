/**
 * server.js
 * Twitch Video & Clip Downloader Web Application Server
 * Built with native Node.js (Zero external npm dependencies)
 * Tích hợp Tìm kiếm/Lọc Category & Views, Tải hàng loạt vào 1 Folder,
 * Cắt đoạn Min/Max và Xuất chuẩn CapCut 16:9 (1080p & 2K).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const {
  parseTwitchUrl,
  getClipInfo,
  getVodInfo,
  getLiveChannelInfo,
  searchTwitchVideosAndClips,
  parseTimeToSeconds,
  POPULAR_CATEGORIES,
  COUNTRY_OPTIONS
} = require('./lib/twitch');
const { checkFfmpegInstalled } = require('./lib/ffmpeg');
const { globalTaskManager, DEFAULT_DOWNLOAD_DIR } = require('./lib/task-manager');

const INITIAL_PORT = parseInt(process.env.PORT || '3080', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const OUTPUTS_DIR = path.join(PUBLIC_DIR, 'outputs');

// Khởi chạy dọn dẹp các file cũ hơn 24 giờ
globalTaskManager.cleanOldTasks().catch(() => {});

// MIME types for static files
const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.ts': 'video/mp2t',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.txt': 'text/plain; charset=UTF-8'
};

function sendJSON(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=UTF-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With'
  });
  res.end(body);
}

function readJSONBody(req, maxSize = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > maxSize) {
        req.destroy();
        reject(new Error('Payload quá lớn (Tối đa 5MB)'));
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (e) {
        reject(new Error('JSON Payload không hợp lệ'));
      }
    });
    req.on('error', reject);
  });
}

function serveStaticFile(req, res, filePath) {
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8' });
      return res.end('404 Not Found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const totalSize = stats.size;
    const rangeHeader = req.headers.range;

    if (rangeHeader) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

      if (start >= totalSize || end >= totalSize) {
        res.writeHead(416, { 'Content-Range': `bytes */${totalSize}` });
        return res.end();
      }

      const chunkSize = (end - start) + 1;
      const fileStream = fs.createReadStream(filePath, { start, end });

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*'
      });
      fileStream.pipe(res);
    } else {
      const isDownload = req.url.includes('download=1');
      const fileName = path.basename(filePath);
      const headers = {
        'Content-Length': totalSize,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*'
      };

      if (isDownload) {
        headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(fileName)}"`;
      }

      res.writeHead(200, headers);
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

async function requestHandler(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(parsedUrl.pathname);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  // 1. Phục vụ trang chủ Web UI
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    return serveStaticFile(req, res, indexPath);
  }

  // 2. API: Lấy thông tin hệ thống (FFmpeg status, Port, Uptime, Categories)
  if (req.method === 'GET' && pathname === '/api/system') {
    const ffmpegStatus = checkFfmpegInstalled();
    return sendJSON(res, 200, {
      status: 'ok',
      ffmpeg: ffmpegStatus,
      port: INITIAL_PORT,
      downloadDir: DEFAULT_DOWNLOAD_DIR,
      popularCategories: POPULAR_CATEGORIES,
      countryOptions: COUNTRY_OPTIONS,
      uptime: process.uptime()
    });
  }

  // 3. YÊU CẦU 1: API Tìm kiếm & Lọc video/clip theo Category, Streamer, Thời lượng (< hoặc > X giờ), Lượt xem
  if (req.method === 'POST' && pathname === '/api/search') {
    try {
      const body = await readJSONBody(req);
      const searchResult = await searchTwitchVideosAndClips(body);
      return sendJSON(res, 200, { success: true, ...searchResult });
    } catch (err) {
      console.error('[API /api/search Error]', err);
      return sendJSON(res, 500, { error: err.message });
    }
  }

  // 4. API: Trích xuất thông tin video Twitch (VOD hoặc Clip)
  if (req.method === 'POST' && pathname === '/api/info') {
    try {
      const body = await readJSONBody(req);
      const urlInput = body.url;
      if (!urlInput) {
        return sendJSON(res, 400, { error: 'Vui lòng cung cấp link video Twitch (url).' });
      }

      const parsedTarget = parseTwitchUrl(urlInput);

      if (parsedTarget.type === 'clip') {
        const clipInfo = await getClipInfo(parsedTarget.slug);
        return sendJSON(res, 200, { success: true, ...clipInfo });
      } else if (parsedTarget.type === 'vod') {
        const vodInfo = await getVodInfo(parsedTarget.id);
        return sendJSON(res, 200, { success: true, ...vodInfo });
      } else if (parsedTarget.type === 'live') {
        const liveInfo = await getLiveChannelInfo(parsedTarget.login);
        return sendJSON(res, 200, { success: true, ...liveInfo });
      } else {
        return sendJSON(res, 400, {
          error: `Đường dẫn Twitch không hợp lệ.`
        });
      }
    } catch (err) {
      console.error('[API /api/info Error]', err);
      return sendJSON(res, 400, { error: err.message });
    }
  }

  // 5. API: Khởi chạy tác vụ tải video đơn lẻ
  if (req.method === 'POST' && pathname === '/api/download') {
    try {
      const body = await readJSONBody(req);
      if (!body.type || (!body.downloadUrl && !body.subM3u8Url)) {
        return sendJSON(res, 400, { error: 'Tham số tải không hợp lệ. Cần có type và URL tải.' });
      }

      // Yêu cầu 1: Chỉ 1 luồng tải duy nhất
      // Yêu cầu 3: Xóa chức năng Time Trimming
      const task = await globalTaskManager.createTask({
        type: body.type,
        title: body.title,
        broadcaster: body.broadcaster,
        game: body.game,
        thumbnailUrl: body.thumbnailUrl,
        duration: body.duration,
        format: body.format || 'mp4',
        resolution: body.resolution || '1080p', // 1080p hoặc 2k
        qualityLabel: body.qualityLabel,
        targetFolder: body.targetFolder || '',   // Thư mục gom nhóm
        downloadUrl: body.downloadUrl,
        subM3u8Url: body.subM3u8Url,
        concurrency: 1
      });

      return sendJSON(res, 201, { success: true, taskId: task.id, metadata: task });
    } catch (err) {
      console.error('[API /api/download Error]', err);
      return sendJSON(res, 500, { error: err.message });
    }
  }

  // 6. YÊU CẦU 2: API Tải hàng loạt nhiều video vào 1 folder chung
  if (req.method === 'POST' && pathname === '/api/batch-download') {
    try {
      const body = await readJSONBody(req);
      const { items = [], targetFolder = 'CapCut_Batch', resolution = '1080p', format = 'mp4' } = body;

      if (!items || items.length === 0) {
        return sendJSON(res, 400, { error: 'Danh sách video tải hàng loạt rỗng.' });
      }

      // Khởi tạo thông tin chi tiết (lấy subM3u8Url hoặc directUrl) cho từng item
      const resolvedItems = [];
      for (const item of items) {
        try {
          if (item.type === 'clip') {
            const clipInfo = await getClipInfo(item.id || item.slug);
            const chosen = (clipInfo.qualities || [])[0] || {};
            resolvedItems.push({
              type: 'clip',
              title: clipInfo.title,
              broadcaster: clipInfo.broadcaster,
              game: clipInfo.game,
              thumbnailUrl: clipInfo.thumbnailUrl,
              duration: clipInfo.durationSeconds,
              downloadUrl: chosen.url,
              qualityLabel: resolution === '2k' ? '2K QHD (CapCut)' : '1080p Full HD (CapCut)'
            });
          } else if (item.type === 'live' || item.isLive) {
            const liveLogin = item.broadcasterLogin || item.login || (item.id ? item.id.replace(/^live_/, '') : '');
            const liveInfo = await getLiveChannelInfo(liveLogin);
            const chosen = (liveInfo.qualities || [])[0] || {};
            resolvedItems.push({
              type: 'live',
              title: liveInfo.title,
              broadcaster: liveInfo.broadcaster,
              game: liveInfo.game,
              thumbnailUrl: liveInfo.thumbnailUrl,
              duration: 0,
              subM3u8Url: chosen.url,
              qualityLabel: resolution === '2k' ? '2K QHD (CapCut)' : '1080p Full HD (CapCut)'
            });
          } else {
            const vodInfo = await getVodInfo(item.id);
            const chosen = (vodInfo.qualities || [])[0] || {};
            resolvedItems.push({
              type: 'vod',
              title: vodInfo.title,
              broadcaster: vodInfo.broadcaster,
              game: vodInfo.game,
              thumbnailUrl: vodInfo.thumbnailUrl,
              duration: vodInfo.durationSeconds,
              subM3u8Url: chosen.url,
              qualityLabel: resolution === '2k' ? '2K QHD (CapCut)' : '1080p Full HD (CapCut)'
            });
          }
        } catch (itemErr) {
          console.warn(`[Batch] Bỏ qua mục ${item.id}:`, itemErr.message);
        }
      }

      const batchResult = await globalTaskManager.createBatchTasks({
        items: resolvedItems,
        targetFolder,
        resolution,
        format,
        concurrency: 1
      });

      return sendJSON(res, 201, batchResult);
    } catch (err) {
      console.error('[API /api/batch-download Error]', err);
      return sendJSON(res, 500, { error: err.message });
    }
  }

  // 7. API: Server-Sent Events (SSE) theo dõi tiến trình thời gian thực
  if (req.method === 'GET' && pathname.startsWith('/api/tasks/') && pathname.endsWith('/events')) {
    const match = pathname.match(/^\/api\/tasks\/([^/]+)\/events$/);
    if (!match) return sendJSON(res, 400, { error: 'Đường dẫn tác vụ không hợp lệ' });

    const taskId = match[1];

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=UTF-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    globalTaskManager.addSSEClient(taskId, res);

    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (e) { clearInterval(heartbeat); }
    }, 15000);

    req.on('close', () => clearInterval(heartbeat));
    return;
  }

  // 8. API: Lấy trạng thái tác vụ qua Polling
  if (req.method === 'GET' && pathname.startsWith('/api/tasks/') && pathname.endsWith('/status')) {
    const match = pathname.match(/^\/api\/tasks\/([^/]+)\/status$/);
    if (!match) return sendJSON(res, 400, { error: 'TaskId không hợp lệ' });

    const taskId = match[1];
    const meta = await globalTaskManager.readMetadata(taskId);
    if (!meta) return sendJSON(res, 404, { error: 'Không tìm thấy tác vụ' });

    return sendJSON(res, 200, meta);
  }

  // 9. API: Hủy tác vụ
  if (req.method === 'POST' && pathname.startsWith('/api/tasks/') && pathname.endsWith('/cancel')) {
    const match = pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
    if (!match) return sendJSON(res, 400, { error: 'TaskId không hợp lệ' });

    const taskId = match[1];
    const meta = await globalTaskManager.cancelTask(taskId);
    return sendJSON(res, 200, { success: true, metadata: meta });
  }

  // 10. API: Lấy danh sách lịch sử tải
  if (req.method === 'GET' && pathname === '/api/history') {
    const list = await globalTaskManager.getTaskHistory();
    return sendJSON(res, 200, list);
  }

  // 11. API: Xóa một tác vụ khỏi lịch sử & đĩa cứng
  if (req.method === 'DELETE' && pathname.startsWith('/api/history/')) {
    const taskId = pathname.replace('/api/history/', '').trim();
    if (!taskId) return sendJSON(res, 400, { error: 'Vui lòng cung cấp taskId để xóa' });

    await globalTaskManager.deleteTask(taskId);
    return sendJSON(res, 200, { success: true });
  }

  // 12. YÊU CẦU 4: Phục vụ file video tải về từ E:\MMO\download-video-twitch (/downloads/...)
  if (pathname.startsWith('/downloads/')) {
    const relPath = pathname.replace(/^\/downloads\//, '');
    const downloadFilePath = path.join(DEFAULT_DOWNLOAD_DIR, relPath);
    if (fs.existsSync(downloadFilePath) && fs.statSync(downloadFilePath).isFile()) {
      return serveStaticFile(req, res, downloadFilePath);
    }
  }

  // 13. Phục vụ file đầu ra tĩnh (/outputs/... hoặc /public/...)
  if (pathname.startsWith('/outputs/')) {
    const relPath = pathname.replace(/^\/outputs\//, '');
    // Kiểm tra trong thư mục E:\MMO\download-video-twitch trước
    const downloadFilePath = path.join(DEFAULT_DOWNLOAD_DIR, relPath);
    if (fs.existsSync(downloadFilePath) && fs.statSync(downloadFilePath).isFile()) {
      return serveStaticFile(req, res, downloadFilePath);
    }
    // Kiểm tra trong thư mục tasks tạm
    const taskFilePath = path.join(globalTaskManager.tasksDir, relPath.replace(/^tasks\//, ''));
    if (fs.existsSync(taskFilePath) && fs.statSync(taskFilePath).isFile()) {
      return serveStaticFile(req, res, taskFilePath);
    }
  }

  const publicFilePath = path.join(PUBLIC_DIR, pathname.replace(/^\/public\//, ''));
  if (fs.existsSync(publicFilePath) && fs.statSync(publicFilePath).isFile()) {
    return serveStaticFile(req, res, publicFilePath);
  }

  // 404 Not Found
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8' });
  res.end('404 Không tìm thấy trang yêu cầu');
}

function startServer(port = INITIAL_PORT, maxAttempts = 10) {
  const server = http.createServer(requestHandler);

  server.listen(port, () => {
    console.log('');
    console.log('===============================================================');
    console.log(`🚀 Twitch Video Downloader Studio đang chạy tại:`);
    console.log(`   👉 http://localhost:${port}`);
    console.log('===============================================================');
    console.log('✨ Sẵn sàng phân tích, tìm kiếm và tải video Twitch chuẩn CapCut.');
    console.log('');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && maxAttempts > 0) {
      console.log(`⚠️  Cổng ${port} đang bận, đang chuyển sang cổng ${port + 1}...`);
      startServer(port + 1, maxAttempts - 1);
    } else {
      console.error('❌ Lỗi khởi động máy chủ:', err.message);
      process.exit(1);
    }
  });
}

startServer();
