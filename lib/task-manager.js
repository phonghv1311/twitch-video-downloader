/**
 * lib/task-manager.js
 * Quản lý vòng đời tác vụ tải video (VOD & Clip), phát tiến trình thời gian thực qua Server-Sent Events (SSE),
 * hỗ trợ tải hàng loạt vào 1 thư mục chung (Batch Folder), xuất chuẩn CapCut (1080p / 2K) và dọn dẹp ổ đĩa.
 */

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { downloadFileWithRetry } = require('./network');
const { HlsDownloader } = require('./hls-downloader');
const { convertClipFile } = require('./ffmpeg');
const { parseSubPlaylistSegments } = require('./twitch');

// YÊU CẦU 4: Thư mục lưu trữ video mặc định: E:\MMO\download-video-twitch
const DEFAULT_DOWNLOAD_DIR = (process.platform === 'win32' && fs.existsSync('E:\\'))
  ? 'E:\\MMO\\download-video-twitch'
  : path.join(__dirname, '..', 'public', 'outputs');

function sanitizeFileName(title, defaultName = 'twitch_video') {
  if (!title || typeof title !== 'string') return defaultName;
  const cleaned = title
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    // Loại bỏ emoji và ký tự điều khiển để tránh lỗi command line và filesystem trên Windows
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 70);

  return cleaned || defaultName;
}

class TaskManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.outputsDir = options.outputsDir || DEFAULT_DOWNLOAD_DIR;
    this.tasksDir = options.tasksDir || path.join(this.outputsDir, '.tasks');
    this.activeTasks = new Map(); // taskId -> { instance, abortController, metadata }
    this.sseClients = new Map();  // taskId -> Set<res>
    this.metaCache = new Map();   // taskId -> in-memory metadata
    this.writeQueues = new Map(); // taskId -> Promise chain để serialize ghi đĩa an toàn trên Windows

    if (!fs.existsSync(this.outputsDir)) {
      try { fs.mkdirSync(this.outputsDir, { recursive: true }); } catch (e) {}
    }
    if (!fs.existsSync(this.tasksDir)) {
      try { fs.mkdirSync(this.tasksDir, { recursive: true }); } catch (e) {}
    }
  }

  getTaskDir(taskId) {
    return path.join(this.tasksDir, taskId);
  }

  getMetadataPath(taskId) {
    return path.join(this.getTaskDir(taskId), 'metadata.json');
  }

  async readMetadata(taskId) {
    if (!taskId) return null;
    if (this.metaCache.has(taskId)) {
      return this.metaCache.get(taskId);
    }

    const metaPath = this.getMetadataPath(taskId);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (!fs.existsSync(metaPath)) return null;
        const raw = await fs.promises.readFile(metaPath, 'utf8');
        if (raw && raw.trim()) {
          const parsed = JSON.parse(raw);
          this.metaCache.set(taskId, parsed);
          return parsed;
        }
      } catch (e) {
        await new Promise(r => setTimeout(r, 60));
      }
    }
    return null;
  }

  async writeMetadata(taskId, metadata) {
    if (!taskId || !metadata) return;
    if (!this.metaCache.has(taskId) && metadata.isDeleted) return;

    try {
      metadata.updatedAt = Date.now();
      this.metaCache.set(taskId, metadata);

      const prevWrite = this.writeQueues.get(taskId) || Promise.resolve();
      const currentWrite = prevWrite.then(async () => {
        try {
          const taskDir = this.getTaskDir(taskId);
          if (!fs.existsSync(taskDir)) {
            await fs.promises.mkdir(taskDir, { recursive: true });
          }

          const metaPath = this.getMetadataPath(taskId);
          const tmpPath = `${metaPath}.${Date.now()}_${Math.random().toString(36).substring(2, 6)}.tmp`;
          const jsonStr = JSON.stringify(metadata, null, 2);

          await fs.promises.writeFile(tmpPath, jsonStr, 'utf8');
          try {
            await fs.promises.rename(tmpPath, metaPath);
          } catch (renameErr) {
            await fs.promises.writeFile(metaPath, jsonStr, 'utf8');
            try { await fs.promises.unlink(tmpPath); } catch (e) {}
          }
        } catch (e) {
          console.warn(`[TaskManager] Lỗi khi ghi metadata cho ${taskId}:`, e.message);
        }
      });

      this.writeQueues.set(taskId, currentWrite);
      return currentWrite;
    } catch (err) {
      console.warn(`[TaskManager] Lỗi writeMetadata cho ${taskId}:`, err.message);
    }
  }

  addSSEClient(taskId, res) {
    if (!this.sseClients.has(taskId)) {
      this.sseClients.set(taskId, new Set());
    }
    this.sseClients.get(taskId).add(res);

    const meta = this.metaCache.get(taskId);
    if (meta) {
      this.sendSSE(res, 'init', meta);
    }

    res.on('close', () => {
      const set = this.sseClients.get(taskId);
      if (set) {
        set.delete(res);
        if (set.size === 0) this.sseClients.delete(taskId);
      }
    });
  }

  sendSSE(res, eventName, data) {
    try {
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) {}
  }

  broadcastSSE(taskId, eventName, data) {
    const clients = this.sseClients.get(taskId);
    if (!clients || clients.size === 0) return;
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try {
        res.write(payload);
      } catch (e) {
        clients.delete(res);
      }
    }
  }

  /**
   * Tạo tác vụ tải mới
   * Hỗ trợ lưu trữ vào thư mục gom nhóm (targetFolder) & độ phân giải chuẩn CapCut (1080p / 2K)
   */
  async createTask(params) {
    const taskId = `twitch_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const taskDir = this.getTaskDir(taskId);
    await fs.promises.mkdir(taskDir, { recursive: true });

    const sanitizedTitle = sanitizeFileName(params.title);
    const ext = params.format || 'mp4';
    const outputFileName = `${sanitizedTitle}_${taskId}.${ext}`;

    // Xử lý thư mục gom nhóm (Yêu cầu 2: tải nhiều video vào 1 folder)
    const targetFolder = (params.targetFolder || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim();

    // Độ phân giải (Yêu cầu 4: chỉ có 1080p và 2k)
    const resolution = (params.resolution === '2k' || params.qualityLabel?.includes('2K')) ? '2k' : '1080p';

    const fileUrl = targetFolder
      ? `/downloads/${encodeURIComponent(targetFolder)}/${encodeURIComponent(outputFileName)}`
      : `/downloads/${encodeURIComponent(outputFileName)}`;

    const metadata = {
      id: taskId,
      type: params.type || 'vod',
      title: params.title || 'Twitch Media',
      broadcaster: params.broadcaster || '',
      game: params.game || '',
      thumbnailUrl: params.thumbnailUrl || '',
      duration: params.duration || 0,
      quality: params.qualityLabel || (resolution === '2k' ? '2K QHD (1440p)' : '1080p Full HD'),
      resolution,
      format: ext,
      targetFolder,
      concurrency: 1, // Yêu cầu 1: Chỉ 1 luồng tải duy nhất
      status: 'queued',
      percent: 0,
      downloadedBytes: 0,
      downloadedMB: '0.00',
      speedMBs: '0.00',
      etaSeconds: 0,
      currentSegment: 0,
      totalSegments: 0,
      finalFileName: outputFileName,
      fileUrl,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      logs: [`[${new Date().toLocaleTimeString()}] Tác vụ đã được khởi tạo thành công.`]
    };

    await this.writeMetadata(taskId, metadata);

    if (params.downloadUrl || params.subM3u8Url) {
      this.startTaskExecution(taskId, params, outputFileName).catch(err => {
        console.error(`[TaskManager] Lỗi thực thi tác vụ ${taskId}:`, err);
      });
    }

    return metadata;
  }

  /**
   * Khởi chạy tải nhiều video vào 1 folder chung (Batch Download)
   */
  async createBatchTasks({ items = [], targetFolder = 'CapCut_Batch', resolution = '1080p', format = 'mp4', concurrency = 1 }) {
    const tasks = [];
    const sanitizedFolder = targetFolder.replace(/[\\/:*?"<>|]/g, '_').trim() || `CapCut_Batch_${Date.now()}`;

    // Đảm bảo thư mục gom nhóm tồn tại
    const folderPath = path.join(this.outputsDir, sanitizedFolder);
    if (!fs.existsSync(folderPath)) {
      await fs.promises.mkdir(folderPath, { recursive: true });
    }

    for (const item of items) {
      const task = await this.createTask({
        ...item,
        targetFolder: sanitizedFolder,
        resolution,
        format,
        concurrency
      });
      tasks.push(task);
    }

    return {
      success: true,
      targetFolder: sanitizedFolder,
      count: tasks.length,
      tasks
    };
  }

  /**
   * Bắt đầu tải video (Xử lý Clip và VOD HLS)
   */
  async startTaskExecution(taskId, params, outputFileName) {
    const taskDir = this.getTaskDir(taskId);
    const metadata = await this.readMetadata(taskId);
    if (!metadata || metadata.isDeleted) return;

    const addLog = async (msg) => {
      if (metadata.isDeleted) return;
      const timeStr = new Date().toLocaleTimeString();
      const logLine = `[${timeStr}] ${msg}`;
      metadata.logs.push(logLine);
      if (metadata.logs.length > 80) metadata.logs.shift();
      await this.writeMetadata(taskId, metadata);
      this.broadcastSSE(taskId, 'log', { log: logLine, logs: metadata.logs });
    };

    try {
      metadata.status = 'downloading';
      await this.writeMetadata(taskId, metadata);
      this.broadcastSSE(taskId, 'status', metadata);

      let finalFilePath = path.join(taskDir, outputFileName);

      if (params.type === 'clip') {
        await addLog(`Bắt đầu tải Clip: "${metadata.title}" [${metadata.resolution.toUpperCase()}]...`);
        const targetUrl = params.downloadUrl;
        if (!targetUrl) throw new Error('Không tìm thấy link tải trực tiếp cho Clip này.');

        const tempClipPath = path.join(taskDir, `raw_clip_${taskId}.mp4`);

        let speedSamples = [];
        const windowMs = 3000;

        const abortCtrl = new AbortController();
        this.activeTasks.set(taskId, { abortController: abortCtrl, metadata });

        await downloadFileWithRetry(
          targetUrl,
          tempClipPath,
          {
            signal: abortCtrl.signal,
            onProgress: (chunk, received, total) => {
              if (metadata.isDeleted) return;
              const now = Date.now();
              speedSamples.push({ time: now, bytes: chunk });
              speedSamples = speedSamples.filter(s => now - s.time <= windowMs);

              const recentBytes = speedSamples.reduce((sum, s) => sum + s.bytes, 0);
              const speedBytesPerSec = speedSamples.length > 0 ? (recentBytes / (windowMs / 1000)) : 0;
              const speedMBs = (speedBytesPerSec / (1024 * 1024)).toFixed(2);

              const percent = total > 0 ? Math.min(Math.round((received / total) * 100), 99) : 50;
              const remainingBytes = total > received ? (total - received) : 0;
              const etaSeconds = speedBytesPerSec > 0 ? Math.round(remainingBytes / speedBytesPerSec) : 0;

              metadata.percent = percent;
              metadata.downloadedBytes = received;
              metadata.downloadedMB = (received / (1024 * 1024)).toFixed(2);
              metadata.speedMBs = speedMBs;
              metadata.etaSeconds = etaSeconds;

              this.broadcastSSE(taskId, 'progress', {
                percent,
                downloadedBytes: received,
                downloadedMB: metadata.downloadedMB,
                speedMBs,
                etaSeconds
              });
            }
          },
          3
        );

        if (metadata.isDeleted) return;

        // Chuyển đổi định dạng sang chuẩn CapCut (1080p hoặc 2K)
        metadata.status = 'remuxing';
        this.broadcastSSE(taskId, 'status', metadata);

        await convertClipFile({
          inputPath: tempClipPath,
          outputPath: finalFilePath,
          format: params.format || 'mp4',
          resolution: metadata.resolution,
          onLog: addLog,
          signal: abortCtrl.signal
        });

        try { fs.unlinkSync(tempClipPath); } catch (e) {}
      } else {
        await addLog(`Đang phân tích playlist phân đoạn HLS: "${metadata.title}" [${metadata.resolution.toUpperCase()}]...`);
        const subM3u8Url = params.subM3u8Url;
        if (!subM3u8Url) throw new Error('Không tìm thấy URL sub-playlist cho video này.');

        const parsed = await parseSubPlaylistSegments(subM3u8Url);

        if (!parsed.selectedSegments || parsed.selectedSegments.length === 0) {
          throw new Error('Không tìm thấy phân đoạn video nào để tải.');
        }

        metadata.totalSegments = parsed.selectedSegments.length;
        await addLog(`Tìm thấy ${parsed.selectedSegments.length} phân đoạn (Thời lượng: ${(parsed.selectedDuration / 60).toFixed(1)} phút).`);

        const downloader = new HlsDownloader({
          concurrency: 1,
          taskDir,
          onProgress: async (p) => {
            if (metadata.isDeleted) return;
            metadata.percent = p.percent;
            metadata.currentSegment = p.completedSegments;
            metadata.totalSegments = p.totalSegments;
            metadata.downloadedBytes = p.downloadedBytes;
            metadata.downloadedMB = p.downloadedMB;
            metadata.speedMBs = p.speedMBs;
            metadata.etaSeconds = p.etaSeconds;
            if (p.status) metadata.status = p.status;

            this.broadcastSSE(taskId, 'progress', p);
          },
          onLog: addLog
        });

        this.activeTasks.set(taskId, {
          instance: downloader,
          abortController: downloader.abortController,
          metadata
        });

        finalFilePath = await downloader.downloadSegments(
          parsed.selectedSegments,
          params.format || 'mp4',
          outputFileName,
          metadata.resolution,
          parsed.initUrl
        );
      }

      if (metadata.isDeleted) return;

      // YÊU CẦU 4: Lưu video trực tiếp vào thư mục chỉ định: E:\MMO\download-video-twitch
      const finalDir = metadata.targetFolder
        ? path.join(this.outputsDir, metadata.targetFolder)
        : this.outputsDir;

      if (!fs.existsSync(finalDir)) {
        await fs.promises.mkdir(finalDir, { recursive: true });
      }

      const finalDestPath = path.join(finalDir, outputFileName);

      // Di chuyển file từ taskDir sang finalDestPath
      if (path.resolve(finalFilePath) !== path.resolve(finalDestPath)) {
        try {
          await fs.promises.rename(finalFilePath, finalDestPath);
        } catch (renameErr) {
          await fs.promises.copyFile(finalFilePath, finalDestPath);
          try { await fs.promises.unlink(finalFilePath); } catch (e) {}
        }
      }

      metadata.finalFilePath = finalDestPath;
      metadata.fileUrl = metadata.targetFolder
        ? `/downloads/${encodeURIComponent(metadata.targetFolder)}/${encodeURIComponent(outputFileName)}`
        : `/downloads/${encodeURIComponent(outputFileName)}`;

      const stat = fs.statSync(finalDestPath);
      metadata.status = 'completed';
      metadata.percent = 100;
      metadata.speedMBs = '0.00';
      metadata.etaSeconds = 0;
      metadata.fileSizeBytes = stat.size;
      metadata.fileSizeMB = (stat.size / (1024 * 1024)).toFixed(2);
      await addLog(`Video chuẩn CapCut đã hoàn tất! Đã lưu tại: "${finalDestPath}" (${metadata.fileSizeMB} MB).`);

      await this.writeMetadata(taskId, metadata);
      this.broadcastSSE(taskId, 'complete', metadata);
    } catch (err) {
      if (!metadata.isDeleted && metadata.status !== 'cancelled' && metadata.status !== 'paused') {
        metadata.status = 'failed';
        metadata.error = err.message;
        await addLog(`Tác vụ thất bại: ${err.message}`);
        await this.writeMetadata(taskId, metadata);
        this.broadcastSSE(taskId, 'error', { error: err.message, metadata });
      }
    } finally {
      this.activeTasks.delete(taskId);
    }
  }

  async cancelTask(taskId) {
    const active = this.activeTasks.get(taskId);
    if (active && active.abortController) {
      active.abortController.abort();
    }
    const metadata = await this.readMetadata(taskId);
    if (metadata) {
      metadata.status = 'cancelled';
      metadata.logs.push(`[${new Date().toLocaleTimeString()}] Người dùng đã hủy tác vụ.`);
      await this.writeMetadata(taskId, metadata);
      this.broadcastSSE(taskId, 'status', metadata);
    }
    this.activeTasks.delete(taskId);
    return metadata;
  }

  async getTaskHistory() {
    try {
      if (!fs.existsSync(this.tasksDir)) return [];
      const dirs = await fs.promises.readdir(this.tasksDir);
      const list = [];

      for (const d of dirs) {
        const meta = await this.readMetadata(d);
        if (meta && !meta.isDeleted) {
          list.push(meta);
        }
      }

      list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return list;
    } catch (e) {
      console.warn('[TaskManager] Lỗi khi đọc lịch sử:', e.message);
      return [];
    }
  }

  async deleteTask(taskId) {
    const active = this.activeTasks.get(taskId);
    if (active && active.abortController) {
      active.abortController.abort();
    }
    this.activeTasks.delete(taskId);

    const cached = this.metaCache.get(taskId);
    if (cached) cached.isDeleted = true;
    this.metaCache.delete(taskId);
    this.writeQueues.delete(taskId);

    const taskDir = this.getTaskDir(taskId);
    if (fs.existsSync(taskDir)) {
      await fs.promises.rm(taskDir, { recursive: true, force: true });
    }
    return { success: true };
  }

  /**
   * Xóa toàn bộ lịch sử tác vụ và dọn dẹp thư mục tác vụ
   */
  async clearAllHistory() {
    try {
      // Dừng và giải phóng tất cả các tác vụ đang hoạt động
      for (const [taskId, active] of this.activeTasks.entries()) {
        if (active && active.abortController) {
          try {
            active.abortController.abort();
          } catch (e) {}
        }
      }
      this.activeTasks.clear();
      this.metaCache.clear();
      this.writeQueues.clear();

      let count = 0;
      if (fs.existsSync(this.tasksDir)) {
        const dirs = await fs.promises.readdir(this.tasksDir);
        count = dirs.length;
        for (const d of dirs) {
          const taskDir = path.join(this.tasksDir, d);
          try {
            await fs.promises.rm(taskDir, { recursive: true, force: true });
          } catch (e) {}
        }
      }
      return { success: true, count };
    } catch (err) {
      console.warn('[TaskManager] Lỗi khi xóa toàn bộ lịch sử:', err.message);
      return { success: false, error: err.message };
    }
  }

  async cleanOldTasks(maxAgeMs = 24 * 60 * 60 * 1000) {
    try {
      const now = Date.now();
      const history = await this.getTaskHistory();
      for (const t of history) {
        if (now - (t.createdAt || 0) > maxAgeMs) {
          await this.deleteTask(t.id);
        }
      }
    } catch (e) {}
  }
}

const globalTaskManager = new TaskManager();

module.exports = {
  TaskManager,
  globalTaskManager,
  DEFAULT_DOWNLOAD_DIR,
  sanitizeFileName
};
