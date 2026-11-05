@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
if not exist "%~dp0.venv\Scripts\python.exe" (
  echo Run Setup.cmd first.
  pause
  exit /b 1
)
if not exist "%~dp0config.json" (
  echo Run Setup.cmd first to create your private config.json.
  pause
  exit /b 1
)
if not exist "%~dp0cookie_claude.txt" (
  echo Save your own signed-in Claude cookie file as cookie_claude.txt in this folder first.
  echo Follow docs\CLAUDE-WEB2API-WINDOWS.md. Do not share this file.
  pause
  exit /b 1
)
echo Starting the local Claude bridge at http://127.0.0.1:8082
echo Keep this window open while using the External connection. Press Ctrl+C to stop.
"%~dp0.venv\Scripts\python.exe" "%~dp0claude_web2api.py"
set "GRAVITY_CLAUDE_EXIT=%ERRORLEVEL%"
echo The Claude bridge stopped.
pause
exit /b %GRAVITY_CLAUDE_EXIT%
