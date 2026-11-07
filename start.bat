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

echo Starting server...
node dist/index.js
pause

