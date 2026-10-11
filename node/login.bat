@echo off
rem Inicia sesion en Telegram para la version en Node (sesion propia: deezload_node.session).
cd /d "%~dp0"
call npm run cli -- login
pause
