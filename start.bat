@echo off
chcp 65001 >nul
title Twitch Video Downloader Studio

echo ===============================================================
echo 🎮  Khởi động Twitch Video Downloader Studio...
echo ===============================================================

:: Tìm đường dẫn thực thi Node.js
set "NODE_CMD=node"
where node >nul 2>&1
if %errorlevel% neq 0 (
    if exist "%LOCALAPPDATA%\Author Software\nvm\.nodejs\node.exe" (
        set "NODE_CMD=%LOCALAPPDATA%\Author Software\nvm\.nodejs\node.exe"
    ) else (
        echo ❌ Không tìm thấy Node.js! Vui lòng cài đặt Node.js từ https://nodejs.org
        pause
        exit /b 1
    )
)

echo 🚀 Đang khởi chạy máy chủ Node.js...
start "" "%NODE_CMD%" "%~dp0server.js"

:: Chờ 1.5 giây để server sẵn sàng
timeout /t 2 /nobreak >nul

echo 🌐 Đang mở giao diện Studio trên trình duyệt web...
start "" "http://localhost:3080"

echo ✨ Hoàn tất! Để đóng server, hãy tắt cửa sổ Node vừa mở.
exit /b 0
