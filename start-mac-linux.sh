#!/bin/sh
set -eu
cd "$(dirname "$0")"
if command -v python3 >/dev/null 2>&1; then
  exec python3 serve.py
elif command -v node >/dev/null 2>&1; then
  exec node serve.mjs
fi
printf '%s\n' 'Python 3 or Node.js was not found. Install one of them and try again.'
exit 1
