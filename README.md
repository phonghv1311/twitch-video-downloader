# Twitch Video & Clip Downloader Studio - Chuẩn CapCut 🎮🎬⚡

Hệ sinh thái ứng dụng Web Studio & CLI hiện đại, chuyên dụng để tìm kiếm, lọc và tải video **Twitch VODs (Past Broadcasts)** và **Twitch Clips** với tỷ lệ **chuẩn 16:9** tối ưu hóa 100% cho **CapCut, Premiere, DaVinci Resolve**, hỗ trợ tải hàng loạt vào 1 thư mục chung và cắt đoạn thông minh theo thời lượng Min/Max.

Ứng dụng được thiết kế theo triết lý kiến trúc tối giản **Zero External Dependencies** (chạy thuần bằng Node.js tiêu chuẩn) học tập và phát triển dựa trên cấu trúc của dự án `tool-fish-audio`.

---

## 📁 Cấu trúc dự án

```text
twitch-video-downloader/
├── server.js              # Máy chủ HTTP & SSE phục vụ Web Studio, Search & REST API (Port: 3080)
├── cli.js                 # Giao diện dòng lệnh (CLI) tải nhanh video bằng Terminal (hỗ trợ 1-30 luồng)
├── start.bat              # Script 1-click khởi động trên Windows & tự mở trình duyệt tại port 3080
├── start.sh               # Script 1-click khởi động trên Linux / macOS
├── package.json           # Cấu hình dự án & kịch bản kiểm thử (test scripts)
├── public/
│   ├── index.html         # Web UI Studio: Tìm kiếm, Lọc Quốc Gia, Tải Batch vào Folder, Cắt Min/Max, CapCut 16:9, Tải tối đa 30 luồng
│   └── outputs/
│       ├── tasks/         # Thư mục lưu trữ tác vụ tạm thời
│       └── [folderName]/  # Các thư mục gom nhóm tải hàng loạt cho CapCut
├── lib/
│   ├── twitch.js          # GraphQL Search & Filter theo Quốc gia / Giờ, Token CloudFront, Usher HLS Master CDN
│   ├── hls-downloader.js  # Bộ tải đa luồng song song (tối đa 30 luồng) các phân đoạn .ts + khôi phục Checkpoint
│   ├── ffmpeg.js          # Bộ điều khiển FFmpeg ghép nối (Remuxing) chuẩn CapCut (1080p & 2K Lanczos)
│   ├── task-manager.js    # Quản lý tác vụ nền, tải hàng loạt vào folder, phát SSE realtime
│   └── network.js         # HTTP/HTTPS Keep-Alive Connection Pool & Resilient Fetch
├── tests/                 # Bộ kiểm thử đơn vị và tích hợp (Unit & Integration Tests)
│   ├── twitch.test.js
│   ├── task-manager.test.js
│   ├── ffmpeg.test.js
│   └── server.test.js
└── README.md              # Tài liệu hướng dẫn sử dụng chi tiết
```

---

## ✨ Các tính năng nổi bật

### 1. 🔍 Tìm kiếm & Bộ lọc nâng cao:
- **Lọc theo Category (Game / Chủ đề):** Minecraft, VALORANT, GTA V, Just Chatting, League of Legends, Dota 2, Counter-Strike, Fortnite, Apex Legends, v.v.
- **Lọc theo Quốc gia / Khu vực (Ưu tiên Views cao):**
  - 🇻🇳 Việt Nam (Ưu tiên các streamer & video xem nhiều nhất VN)
  - 🇺🇸 Mỹ / Quốc tế (US/EN)
  - 🇯🇵 Nhật Bản (JP)
  - 🇰🇷 Hàn Quốc (KR)
  - 🇪🇸 Tây Ban Nha (ES)
  - 🇫🇷 Pháp (FR)
  - 🇩🇪 Đức (DE)
  - 🇧🇷 Brazil / Bồ Đào Nha (PT/BR)
  - 🇷🇺 Nga (RU)
  - 🇹🇭 Thái Lan (TH)
- **Lọc theo khoảng thời lượng (Between Từ ... Đến ...):**
  - Cho phép chọn chính xác khoảng thời gian video (Từ Min đến Max, ví dụ: 0 - 30p, 30p - 1h, 1h - 2h, 2h - 4h, > 4h...).
- **Sắp xếp thông minh:** Tự động ưu tiên **Lượt xem nhiều nhất (Views cao nhất)**, hoặc sắp xếp theo Mới phát sóng nhất, Thời lượng dài nhất / ngắn nhất.

### 2. ⚡ Tăng công suất tải tối đa lên 30 luồng & Tương thích 100% fMP4 CMAF / TS:
- Cho phép tùy chỉnh thanh trượt số luồng từ **3 đến 30 luồng song song** (30 threads max).
- Hỗ trợ toàn diện cả chuẩn **fMP4 (CMAF với `#EXT-X-MAP` init header)** và **MPEG-TS** truyền thống, tự động ghép nối stream mượt mà, khắc phục triệt để lỗi `error reading header`.
- Hiển thị trực quan: % tiến độ, số phân đoạn (vd: 120/120 phân đoạn), tốc độ tải (MB/s), dung lượng đã tải (MB), thời gian ước tính còn lại (ETA).

### 3. 📁 Lưu video trực tiếp tại `E:\MMO\download-video-twitch` & Tải Batch vào Folder:
- Toàn bộ video khi tải về được lưu trực tiếp vào thư mục:
  👉 **`E:\MMO\download-video-twitch`**
- Hỗ trợ tải hàng loạt (Batch Download) nhiều video cùng lúc vào một thư mục con bên trong `E:\MMO\download-video-twitch\<tên_folder>\` giúp bạn import cả folder vào CapCut nhanh chóng.

### 4. ✂️ Cắt đoạn video (Time Trimming) không giới hạn, mặc định tối đa 4 tiếng:
- Nhập mốc **Bắt đầu (Start)** & **Kết thúc (End)**.
- Bỏ mọi giới hạn bắt buộc min/max; mặc định mốc cắt tối đa là **4 tiếng** (`04:00:00`).
- Các nút preset chọn nhanh: `30s`, `1 phút`, `5 phút`, `15 phút`, `30 phút`, `1 tiếng`, `2 tiếng`, `4 tiếng (Max)`.
- Chỉ báo trạng thái trực quan, không bao giờ chặn tải.
- Chỉ báo trạng thái trực quan: Tự động cảnh báo nếu đoạn cắt dưới mức Min hoặc vượt quá mức Max.

### 5. 🎬 Mặc định tỷ lệ 16:9, tinh gọn chỉ 2 tùy chọn 1080p & 2K chuẩn CapCut:
- Cố định tỷ lệ chuẩn **16:9** (khung hình chuẩn CapCut / Premiere / YouTube).
- Menu chọn độ phân giải tinh gọn CHỈ CÒN 2 OPTION:
  1. **1080p Full HD (1920x1080, 16:9) [Mặc định CapCut]**: Direct stream copy tức thì, giữ nguyên chất lượng gốc.
  2. **2K QHD (2560x1440, 16:9) [Siêu sắc nét CapCut]**: Nâng cấp bằng bộ lọc chất lượng cao Lanczos (`flags=lanczos,setdar=16/9,format=yuv420p`).
- **Định dạng tối ưu hóa 100% cho CapCut:**
  - Video Codec: **H.264 (AVC)** chuẩn màu **`yuv420p`** (khắc phục hoàn toàn lỗi màn hình đen/xanh trong CapCut).
  - Audio Codec: **AAC Stereo 48kHz**.
  - Cờ **`+faststart`**: Đưa moov atom lên đầu file giúp CapCut import và preview ngay lập tức.

---

## 🚀 Hướng dẫn khởi chạy

### 1. Khởi chạy 1-Click trên Windows:
Chỉ cần nhấp đúp chuột vào file:
```cmd
start.bat
```
Script sẽ tự động tìm kiếm Node.js, khởi động máy chủ và mở trình duyệt tại địa chỉ:
👉 **`http://localhost:3080`**

### 2. Khởi chạy bằng dòng lệnh Node.js:
```bash
node server.js
```
Truy cập: **[http://localhost:3080](http://localhost:3080)** (tự động chuyển sang 3081 nếu cổng 3080 đang bận).

---

## 📡 Các API RESTful chính

- `POST /api/search`: Tìm kiếm & lọc video/clip (`query`, `category`, `country`, `hoursFilter`, `sortBy`).
- `POST /api/batch-download`: Tải nhiều video vào 1 folder chung (`items`, `targetFolder`, `resolution`, `concurrency`).
- `POST /api/info`: Phân tích URL Twitch đơn lẻ.
- `POST /api/download`: Khởi chạy tải video đơn kèm cắt đoạn Min/Max & concurrency.
- `GET /api/tasks/:id/events`: Nhận sự kiện tiến độ realtime qua SSE.
- `GET /api/history`: Lấy lịch sử video đã tải.

---

## 🧪 Kiểm thử tự động (100% PASS)
Chạy bộ kiểm thử toàn diện:
```bash
npm test
```
Kiểm thử bao gồm:
- URL Twitch & Category Search.
- Serialize ghi đĩa & Batch Folder Task Manager.
- FFmpeg CapCut Presets (1080p / 2K).
- Server API Search, Batch Download & Trimming Validation.
