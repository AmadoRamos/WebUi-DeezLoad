@echo off
rem Descarga un album.
rem Uso:  descargar.bat "Artista" "Album" [n]
cd /d "%~dp0"
if "%~2"=="" (
  echo Uso: descargar.bat "Artista" "Album" [n]
  exit /b 1
)
call npm run --silent cli -- download "%~1" "%~2" %3
pause
