#!/usr/bin/env bash
# Script 1-click khởi chạy Twitch Video Downloader Studio

echo "==============================================================="
echo "🎮  Khởi động Twitch Video Downloader Studio..."
echo "==============================================================="

if ! command -v node &> /dev/null; then
    echo "❌ Lỗi: Node.js chưa được cài đặt. Vui lòng cài đặt Node.js."
    exit 1
fi

cd "$(dirname "$0")"

PORT=${PORT:-3080}
echo "🚀 Đang khởi chạy server trên cổng $PORT..."
node server.js &
SERVER_PID=$!
sleep 2

echo "🌐 Mở http://localhost:$PORT trên trình duyệt..."
if [[ "$OSTYPE" == "darwin"* ]]; then
    open "http://localhost:$PORT"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    xdg-open "http://localhost:$PORT" &> /dev/null || true
fi

echo "✨ Máy chủ đang chạy (PID: $SERVER_PID). Nhấn Ctrl+C để dừng."
wait $SERVER_PID
