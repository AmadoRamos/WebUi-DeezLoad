@echo off
rem Descarga un album con la version en Node.
rem Uso:  descargar.bat "Artista" "Album" [n]
rem No dejes el servidor web de Python (run_web.bat) abierto mientras tanto.
cd /d "%~dp0"
if "%~2"=="" (
  echo Uso: descargar.bat "Artista" "Album" [n]
  exit /b 1
)
call npm run --silent cli -- download "%~1" "%~2" %3
pause
