@echo off
cd /d "%~dp0"
echo Creando entorno virtual en .venv ...
py -3 -m venv .venv 2>NUL || python -m venv .venv
if not exist ".venv\Scripts\python.exe" (
  echo No se pudo crear el venv. Revisa que Python este instalado y en el PATH.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt
echo.
echo Dependencias instaladas. Iniciando sesion en Telegram (telefono y codigo):
".venv\Scripts\python.exe" deezload_mcp.py login
echo.
pause
