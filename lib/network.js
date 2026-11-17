/**
 * lib/network.js
 * Quản lý kết nối HTTP/HTTPS Connection Pool, fetch dữ liệu và stream download có hỗ trợ Resume & Retry.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');

let sharedHttpsAgent = null;
let sharedHttpAgent = null;

function getHttpsAgent() {
  if (!sharedHttpsAgent) {
    sharedHttpsAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 256,
      maxFreeSockets: 64,
      timeout: 60000,
      keepAliveMsecs: 30000
    });
  }
  return sharedHttpsAgent;
}

function getHttpAgent() {
  if (!sharedHttpAgent) {
    sharedHttpAgent = new http.Agent({
      keepAlive: true,
      maxSockets: 256,
      maxFreeSockets: 64,
      timeout: 60000,
      keepAliveMsecs: 30000
    });
  }
  return sharedHttpAgent;
}

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://www.twitch.tv',
  'Referer': 'https://www.twitch.tv/'
};

/**
 * Thực hiện yêu cầu HTTP/HTTPS trả về chuỗi Text
 */
function fetchText(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const isHttps = parsed.protocol === 'https:';
    const client = isHttps ? https : http;
    const agent = isHttps ? getHttpsAgent() : getHttpAgent();

    const headers = { ...DEFAULT_HEADERS, ...(options.headers || {}) };
    const reqOptions = {
      method: options.method || 'GET',
      headers,
      agent,
      timeout: options.timeout || 30000
    };

    const req = client.request(parsed, reqOptions, (res) => {
      // Xử lý chuyển hướng (Redirects 301, 302, 307, 308)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, urlStr).toString();
        return resolve(fetchText(redirectUrl, { ...options, redirectCount: (options.redirectCount || 0) + 1 }));
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`Yêu cầu HTTP thất bại với mã trạng thái ${res.statusCode}: ${urlStr}`));
      }

      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });

    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        req.destroy();
        reject(new Error('Yêu cầu đã bị hủy'));
      });
    }

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Hết thời gian chờ (Timeout) khi tải URL: ${urlStr}`));
    });

    req.on('error', reject);

    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

/**
 * Thực hiện yêu cầu HTTP/HTTPS trả về đối tượng JSON
 */
async function fetchJSON(urlStr, options = {}) {
  const text = await fetchText(urlStr, options);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Phản hồi không phải định dạng JSON hợp lệ: ${text.substring(0, 150)}...`);
  }
}

/**
 * Tải file trực tiếp và ghi vào ổ đĩa kèm theo dõi tiến trình
 * Hỗ trợ tự động thử lại (Retry) khi gặp lỗi mạng
 */
async function downloadFileWithRetry(urlStr, destPath, options = {}, maxRetries = 3) {
  let attempt = 0;
  let lastErr = null;

  while (attempt < maxRetries) {
    attempt++;
    try {
      await downloadFile(urlStr, destPath, options);
      return;
    } catch (err) {
      lastErr = err;
      if (options.signal && options.signal.aborted) {
        throw new Error('Tải file đã bị hủy');
      }
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }
  throw lastErr;
}

/**
 * Stream download file từ URL vào destPath
 */
function downloadFile(urlStr, destPath, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const isHttps = parsed.protocol === 'https:';
    const client = isHttps ? https : http;
    const agent = isHttps ? getHttpsAgent() : getHttpAgent();

    const headers = { ...DEFAULT_HEADERS, ...(options.headers || {}) };
    const reqOptions = {
      method: 'GET',
      headers,
      agent,
      timeout: options.timeout || 30000
    };

    const req = client.request(parsed, reqOptions, (res) => {
      // Xử lý chuyển hướng
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, urlStr).toString();
        return resolve(downloadFile(redirectUrl, destPath, options));
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`Tải file thất bại với mã ${res.statusCode}: ${urlStr}`));
      }

      const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
      let receivedBytes = 0;

      const fileStream = fs.createWriteStream(destPath, { flags: 'w' });

      res.on('data', (chunk) => {
        receivedBytes += chunk.length;
        if (typeof options.onProgress === 'function') {
          options.onProgress(chunk.length, receivedBytes, totalBytes);
        }
      });

      res.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close(resolve);
      });

      fileStream.on('error', (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
    });

    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        req.destroy();
        fs.unlink(destPath, () => {});
        reject(new Error('Yêu cầu tải bị hủy'));
      });
    }

    req.on('timeout', () => {
      req.destroy();
      fs.unlink(destPath, () => {});
      reject(new Error(`Timeout khi tải: ${urlStr}`));
    });

    req.on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });

    req.end();
  });
}

module.exports = {
  fetchText,
  fetchJSON,
  downloadFile,
  downloadFileWithRetry,
  getHttpsAgent,
  getHttpAgent,
  DEFAULT_HEADERS
};
