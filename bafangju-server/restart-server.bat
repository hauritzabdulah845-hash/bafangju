@echo off
chcp 65001 >nul
cd /d %~dp0
echo [1/2] Stopping old server on port 3000...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3000" ^| findstr "LISTENING"') do taskkill /f /pid %%p >nul 2>nul
timeout /t 1 /nobreak >nul
echo [2/2] Starting backend server...
echo.
where node >nul 2>nul
if %errorlevel%==0 (
  node src/server.js
) else (
  if exist "C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe" (
    "C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe" src/server.js
  ) else (
    echo [ERROR] Node.js not found. Please install LTS from https://nodejs.org
  )
)
echo.
echo [Server stopped] Double-click this file again to restart
pause
