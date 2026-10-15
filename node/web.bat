@echo off
rem Servidor web en http://127.0.0.1:8000.
cd /d "%~dp0"
call npm run --silent web -- %*
pause
