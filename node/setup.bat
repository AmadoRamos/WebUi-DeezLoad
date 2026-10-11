@echo off
rem Instala las dependencias de la version en Node.js (una vez, o tras actualizar).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo No se encontro Node.js. Instala la version LTS desde https://nodejs.org y vuelve a ejecutar este archivo.
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo Se necesita Node.js 20 o superior. Tienes:
  node -v
  pause
  exit /b 1
)
call npm install
echo.
echo Listo. Primer paso: inicia sesion con  login.bat
pause
