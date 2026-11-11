#!/bin/sh
# Браузер запускает хост с урезанным PATH, без Homebrew — без этой строки не найдутся yt-dlp и ffmpeg.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
exec python3 "$(dirname "$0")/native_host.py"
