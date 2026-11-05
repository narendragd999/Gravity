@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (
  echo Install Python 3.10 or newer from python.org with the Python launcher enabled, then run Setup.cmd again.
  pause
  exit /b 1
)
py -3 -m venv "%~dp0.venv"
if errorlevel 1 goto failed
"%~dp0.venv\Scripts\python.exe" -m pip install -r "%~dp0requirements.txt"
if errorlevel 1 goto failed
if not exist "%~dp0config.json" copy /y "%~dp0config.example.json" "%~dp0config.json" >nul
echo Setup finished. Save your own Claude cookies as cookie_claude.txt here, then run Start.cmd.
echo Full instructions: docs\CLAUDE-WEB2API-WINDOWS.md in the Gravity source folder.
pause
exit /b 0
:failed
echo Setup did not finish. Read the error above and retry after correcting it.
pause
exit /b 1
