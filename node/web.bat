@echo off
rem Servidor web en Node (la misma interfaz que run_web.bat, en http://127.0.0.1:8000).
rem No lo abras a la vez que el de Python: los dos hablarian con el bot.
cd /d "%~dp0"
call npm run --silent web -- %*
pause
