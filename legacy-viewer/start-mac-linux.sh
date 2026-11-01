#!/bin/sh
cd "$(dirname "$0")"
echo "Open http://localhost:8000  (Ctrl+C to stop)"
( sleep 1; (xdg-open http://localhost:8000/ || open http://localhost:8000/) >/dev/null 2>&1 ) &
python3 -m http.server 8000 || npx --yes http-server -p 8000
