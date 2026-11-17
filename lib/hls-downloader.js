/**
 * lib/hls-downloader.js
 * Quản lý tải song song đa luồng các phân đoạn HLS (.ts),
 * tự động khôi phục (Resume/Checkpoint), tính toán tốc độ/ETA thời gian thực và remux thành phẩm.
 */

const fs = require('fs');
const path = require('path');
const { downloadFileWithRetry } = require('./network');
const { remuxSegments } = require('./ffmpeg');

class HlsDownloader {
  constructor(options = {}) {
    this.concurrency = Math.min(Math.max(parseInt(options.concurrency || '16', 10), 1), 30);
    this.taskDir = options.taskDir;
    this.segmentsDir = path.join(this.taskDir, 'segments');
    this.onProgress = options.onProgress || (() => {});
    this.onLog = options.onLog || (() => {});
    this.abortController = new AbortController();

    if (!fs.existsSync(this.segmentsDir)) {
      fs.mkdirSync(this.segmentsDir, { recursive: true });
    }
  }

  cancel() {
    this.abortController.abort();
  }

  /**
   * Khởi chạy quá trình tải đa luồng danh sách phân đoạn
   */
  async downloadSegments(segments, format = 'mp4', outputFileName = 'video.mp4', resolution = '1080p', initUrl = null) {
    const totalSegments = segments.length;
    let completedCount = 0;
    let totalBytesDownloaded = 0;

    const resolvedInitUrl = initUrl || segments.find(s => s.initUrl)?.initUrl || null;
    const initFilePath = path.join(this.taskDir, 'init.mp4');

    if (resolvedInitUrl) {
      if (!fs.existsSync(initFilePath) || fs.statSync(initFilePath).size === 0) {
        this.onLog(`Tải phân đoạn khởi tạo fMP4 (init header)...`);
        await downloadFileWithRetry(resolvedInitUrl, initFilePath, { signal: this.abortController.signal });
      }
    }

    // Bộ đo tốc độ mạng theo cửa sổ trượt (Rolling Window)
    let speedSamples = [];
    const windowMs = 3000;

    this.onLog(`Chuẩn bị tải ${totalSegments} phân đoạn video bằng ${this.concurrency} luồng song song...`);

    // Kiểm tra các phân đoạn đã tải từ trước để hỗ trợ Resume
    for (let i = 0; i < totalSegments; i++) {
      const seg = segments[i];
      const segFileName = `seg_${String(i).padStart(6, '0')}.ts`;
      const segPath = path.join(this.segmentsDir, segFileName);

      try {
        if (fs.existsSync(segPath)) {
          const stat = fs.statSync(segPath);
          if (stat.size > 0) {
            completedCount++;
            totalBytesDownloaded += stat.size;
          }
        }
      } catch (e) {}
    }

    if (completedCount > 0) {
      this.onLog(`Phát hiện tiến trình cũ: Khôi phục và bỏ qua ${completedCount}/${totalSegments} phân đoạn đã tải sẵn.`);
    }

    // Danh sách các index cần tải
    const pendingIndices = [];
    for (let i = 0; i < totalSegments; i++) {
      const segFileName = `seg_${String(i).padStart(6, '0')}.ts`;
      const segPath = path.join(this.segmentsDir, segFileName);
      if (!fs.existsSync(segPath) || fs.statSync(segPath).size === 0) {
        pendingIndices.push(i);
      }
    }

    let nextQueueIdx = 0;

    const worker = async () => {
      while (nextQueueIdx < pendingIndices.length) {
        if (this.abortController.signal.aborted) {
          throw new Error('Tác vụ tải đã bị hủy hoặc tạm dừng.');
        }

        const segIndex = pendingIndices[nextQueueIdx++];
        const seg = segments[segIndex];
        const segFileName = `seg_${String(segIndex).padStart(6, '0')}.ts`;
        const segPath = path.join(this.segmentsDir, segFileName);

        let segDownloadedBytes = 0;

        await downloadFileWithRetry(
          seg.url,
          segPath,
          {
            signal: this.abortController.signal,
            onProgress: (chunkBytes) => {
              const now = Date.now();
              totalBytesDownloaded += chunkBytes;
              segDownloadedBytes += chunkBytes;

              // Ghi nhận mẫu tốc độ
              speedSamples.push({ time: now, bytes: chunkBytes });
              speedSamples = speedSamples.filter(s => now - s.time <= windowMs);
            }
          },
          3
        );

        completedCount++;

        // Tính tốc độ trung bình và ước tính thời gian hoàn thành (ETA)
        const now = Date.now();
        const recentBytes = speedSamples.reduce((sum, s) => sum + s.bytes, 0);
        const speedBytesPerSec = speedSamples.length > 0 ? (recentBytes / (windowMs / 1000)) : 0;
        const speedMBs = (speedBytesPerSec / (1024 * 1024)).toFixed(2);

        const percent = Math.min(Math.round((completedCount / totalSegments) * 100), 99);
        const remainingSegments = totalSegments - completedCount;
        const avgSegBytes = completedCount > 0 ? (totalBytesDownloaded / completedCount) : 0;
        const estimatedBytesRemaining = remainingSegments * avgSegBytes;
        const etaSeconds = speedBytesPerSec > 0 ? Math.round(estimatedBytesRemaining / speedBytesPerSec) : 0;

        this.onProgress({
          status: 'downloading',
          percent,
          completedSegments: completedCount,
          totalSegments,
          downloadedBytes: totalBytesDownloaded,
          downloadedMB: (totalBytesDownloaded / (1024 * 1024)).toFixed(2),
          speedMBs,
          etaSeconds,
          log: `Đang tải phân đoạn ${completedCount}/${totalSegments} (${percent}%) - Tốc độ: ${speedMBs} MB/s`
        });
      }
    };

    // Chạy song song N worker
    const threadCount = Math.min(this.concurrency, pendingIndices.length || 1);
    const workers = Array.from({ length: threadCount }, () => worker());
    await Promise.all(workers);

    this.onLog(`Tất cả ${totalSegments} phân đoạn đã được tải về hoàn tất! Bắt đầu ghép nối (Remux)...`);

    this.onProgress({
      status: 'remuxing',
      percent: 99,
      completedSegments: totalSegments,
      totalSegments,
      downloadedBytes: totalBytesDownloaded,
      downloadedMB: (totalBytesDownloaded / (1024 * 1024)).toFixed(2),
      speedMBs: '0.00',
      etaSeconds: 0,
      log: 'Đang tiến hành ghép nối dữ liệu stream thành video hoàn chỉnh...'
    });

    // Đường dẫn file video thành phẩm
    const finalOutputPath = path.join(this.taskDir, outputFileName);

    if (resolvedInitUrl) {
      this.onLog(`Đang ghép nối các phân đoạn fMP4 và init header thành luồng video hoàn chỉnh...`);
      const combinedRawPath = path.join(this.taskDir, 'combined_raw.mp4');
      const outWriteStream = fs.createWriteStream(combinedRawPath, { flags: 'w' });

      if (fs.existsSync(initFilePath)) {
        await new Promise((res, rej) => {
          const r = fs.createReadStream(initFilePath);
          r.on('error', rej);
          r.on('end', res);
          r.pipe(outWriteStream, { end: false });
        });
      }

      for (let i = 0; i < totalSegments; i++) {
        if (this.abortController.signal.aborted) throw new Error('Tác vụ tải đã bị hủy.');
        const segFileName = `seg_${String(i).padStart(6, '0')}.ts`;
        const segPath = path.join(this.segmentsDir, segFileName);
        if (fs.existsSync(segPath)) {
          await new Promise((res, rej) => {
            const r = fs.createReadStream(segPath);
            r.on('error', rej);
            r.on('end', res);
            r.pipe(outWriteStream, { end: false });
          });
        }
      }

      await new Promise((res, rej) => {
        outWriteStream.on('finish', res);
        outWriteStream.on('error', rej);
        outWriteStream.end();
      });

      // Thực hiện Remuxing fMP4 bằng FFmpeg
      await remuxSegments({
        inputPath: combinedRawPath,
        outputPath: finalOutputPath,
        format,
        resolution,
        isFmp4: true,
        onLog: this.onLog,
        signal: this.abortController.signal
      });

      // Dọn dẹp các phân đoạn tạm sau khi remux thành công để giải phóng dung lượng
      try {
        this.cleanupSegments();
        if (fs.existsSync(combinedRawPath)) fs.unlinkSync(combinedRawPath);
        if (fs.existsSync(initFilePath)) fs.unlinkSync(initFilePath);
      } catch (e) {
        this.onLog(`Cảnh báo khi dọn dẹp phân đoạn tạm: ${e.message}`);
      }
    } else {
      // Dành cho luồng MPEG-TS truyền thống (không dùng init.mp4)
      const concatListPath = path.join(this.taskDir, 'concat.txt');
      const concatLines = [];
      for (let i = 0; i < totalSegments; i++) {
        const segFileName = `seg_${String(i).padStart(6, '0')}.ts`;
        const absoluteSegPath = path.join(this.segmentsDir, segFileName).replace(/\\/g, '/');
        concatLines.push(`file '${absoluteSegPath}'`);
      }
      fs.writeFileSync(concatListPath, concatLines.join('\n'), 'utf8');

      await remuxSegments({
        concatListPath,
        outputPath: finalOutputPath,
        format,
        resolution,
        isFmp4: false,
        onLog: this.onLog,
        signal: this.abortController.signal
      });

      try {
        this.cleanupSegments();
        if (fs.existsSync(concatListPath)) fs.unlinkSync(concatListPath);
      } catch (e) {
        this.onLog(`Cảnh báo khi dọn dẹp phân đoạn tạm: ${e.message}`);
      }
    }

    return finalOutputPath;
  }

  cleanupSegments() {
    if (fs.existsSync(this.segmentsDir)) {
      const files = fs.readdirSync(this.segmentsDir);
      for (const f of files) {
        try {
          fs.unlinkSync(path.join(this.segmentsDir, f));
        } catch (e) {}
      }
      try {
        fs.rmdirSync(this.segmentsDir);
      } catch (e) {}
    }
  }
}

module.exports = {
  HlsDownloader
};
