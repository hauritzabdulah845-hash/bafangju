@echo off
chcp 65001 >nul
cd /d %~dp0
echo ============================================
echo   BaFangJu Platform - Backend Server
echo.
echo   Open in browser: http://localhost:3000
echo   Mobile / MiniProgram: http://192.168.1.11:3000
echo.
echo   NOTE: Closing this window STOPS the server
echo ============================================
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
