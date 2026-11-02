@echo off
setlocal
cd /d "%~dp0"
echo Starting Mannequin Viewer on http://localhost:8000
where py >nul 2>&1
if not errorlevel 1 (
  py -3 serve.py
  if not errorlevel 1 goto :done
)
where python >nul 2>&1
if not errorlevel 1 (
  python serve.py
  if not errorlevel 1 goto :done
)
where node >nul 2>&1
if not errorlevel 1 (
  node serve.mjs
  goto :done
)
echo Python 3 or Node.js was not found. Install either runtime and try again.
pause
:done
endlocal
