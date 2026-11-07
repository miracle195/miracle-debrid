@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Miracle Debrid with HTTPS (Stremio Web)

echo ===================================================
echo       MIRACLE DEBRID + HTTPS TUNNEL (STREMIO WEB)
echo ===================================================
echo.

if not exist "bin" mkdir bin

if not exist "bin\cloudflared.exe" (
  echo Downloading cloudflared for free instant HTTPS tunnel...
  curl.exe -L -# -o "bin\cloudflared.exe" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
  if not exist "bin\cloudflared.exe" (
    echo [ERROR] Could not download cloudflared.
    pause
    exit /b 1
  )
)

if not exist "dist\index.js" (
  echo Compiling TypeScript...
  call npm run build
)

for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":11480" ^| findstr "LISTENING"') do (
  echo Cleaning up previous server on port 11480 ^(PID %%a^)...
  taskkill /F /PID %%a >nul 2>&1
)

echo Starting Miracle Debrid in background...
start "Miracle Debrid Node" cmd /k "node dist/index.js"

echo.
echo ===================================================
echo Starting Cloudflare HTTPS Tunnel...
echo Look for your free HTTPS URL ending in:
echo   https://xxxxxxxx.trycloudflare.com
echo.
echo Then in Stremio Web (web.stremio.com), paste:
echo   https://xxxxxxxx.trycloudflare.com/198d93aa73665d012157b38a718ab7b4/manifest.json
echo ===================================================
echo.

bin\cloudflared.exe tunnel --url http://localhost:11480
pause

