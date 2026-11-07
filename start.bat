@echo off
setlocal
cd /d "%~dp0"
title Miracle Debrid Server

echo ===================================================
echo               MIRACLE DEBRID SERVER
echo ===================================================
echo.

if not exist "dist\index.js" (
  echo Compiling TypeScript...
  call npm run build
)

for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":11480" ^| findstr "LISTENING"') do (
  echo Cleaning up previous server on port 11480 ^(PID %%a^)...
  taskkill /F /PID %%a >nul 2>&1
)

echo Starting server...
node dist/index.js
pause

