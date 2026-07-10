@echo off
rem WAgent backend launcher with crash-restart loop.
rem Runs the production server on the port the extension expects (8787)
rem and appends logs to ..\data\backend.log so problems are diagnosable.
rem Used directly (double-click) or hidden at login via install-autostart.ps1.

cd /d "%~dp0"
if not exist "..\data" mkdir "..\data"

rem Force UTF-8 I/O. Without this, redirecting output to a log file makes
rem Python fall back to the legacy Windows cp1252 encoding, which cannot
rem encode the emoji in FastAPI/Rich's startup banner (UnicodeEncodeError)
rem and crashes the server before it ever binds the port.
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8

:loop
echo [%date% %time%] starting backend >> "..\data\backend.log"
uv run fastapi run main.py --host 127.0.0.1 --port 8787 >> "..\data\backend.log" 2>&1
echo [%date% %time%] backend exited, restarting in 3s >> "..\data\backend.log"
timeout /t 3 /nobreak >nul
goto loop
