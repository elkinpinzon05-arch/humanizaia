@echo off
echo Iniciando HumanizaIA...
echo.

set NODE="C:\node-v24.14.0-win-x64\node-v24.14.0-win-x64\node.exe"

%NODE% --version >nul 2>&1
if errorlevel 1 (
  echo ERROR: No se encontro node.exe en la ruta esperada.
  echo Ruta buscada: C:\node-v24.14.0-win-x64\node-v24.14.0-win-x64\node.exe
  pause
  exit
)

echo Node.js OK
echo Servidor corriendo en http://localhost:3000
echo Presiona Ctrl+C para detener.
echo.
start "" http://localhost:3000
%NODE% "%~dp0server.js"
pause
