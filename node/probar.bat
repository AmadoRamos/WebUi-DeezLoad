@echo off
rem Compara la version en Node con la de Python para un artista.
rem Uso:  probar.bat "Soda Stereo"
rem No dejes el servidor web (python\run_web.bat) abierto mientras tanto: los dos hablarian con el bot a la vez.
cd /d "%~dp0"
if "%~1"=="" (
  echo Uso: probar.bat "Nombre del artista"
  exit /b 1
)
echo Node.js...
call npm run --silent cli -- albums "%~1" > albums_node.json
echo Python...
"..\python\.venv\Scripts\python.exe" ..\python\deezload_mcp.py albums "%~1" > albums_python.json
echo.
echo Resultados en albums_node.json y albums_python.json
fc /n albums_node.json albums_python.json
pause
