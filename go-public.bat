@echo off
rem ===========================================================================
rem  Pillbox — make it PUBLIC (internet-accessible) + ESP32-ready.
rem  --------------------------------------------------------------------------
rem  What this does:
rem   1. Installs deps + prepares the local SQLite DB.
rem   2. Builds the web app and starts the backend on :4000 (serves the
rem      app AND the API on one port, so there is a single origin).
rem   3. If Cloudflare Tunnel (cloudflared) is installed, opens a FREE
rem      public HTTPS URL (no card, no domain needed). The ESP32 hardware
rem      keeps working because the bridge talks to localhost:4000 locally.
rem  Requires Node.js (see requirements.txt). Cloudflared is optional — if
rem  missing, the script tells you how to install it (one command).
rem ===========================================================================
cd /d "%~dp0"

echo.
echo  ============================================================
echo   Pillbox — go public
echo  ============================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo  [X] Node.js not found. Install it from https://nodejs.org then re-run.
  pause
  exit /b 1
)
echo  [OK] Node.js found.
echo.

echo  [..] Installing dependencies...
call npm install
if errorlevel 1 ( echo  [X] npm install failed. && pause && exit /b 1 )
echo  [OK] Dependencies installed.
echo.

echo  [..] Generating Prisma client + database...
call npm run prisma:generate
call npm run prisma:migrate
echo  [OK] Database ready.
echo.

echo  [..] Building the web app (creates client/dist)...
call npm run build -w client
if errorlevel 1 ( echo  [X] Build failed. && pause && exit /b 1 )
echo  [OK] App built.
echo.

echo  [..] Starting backend on http://localhost:4000 (app + API)...
start "Pillbox Server" cmd /k npm run dev:server

rem ---- Cloudflare Tunnel (free public HTTPS) ----------------------------
where cloudflared >nul 2>&1
if errorlevel 1 (
  echo.
  echo  [!!] Cloudflared is not installed yet. To get a FREE public URL:
  echo        1. Open a terminal and run:  winget install Cloudflare.Cloudflared
  echo           (or download from https://developers.cloudflare.com/cloudflared/)
  echo        2. Login once:            cloudflared tunnel login
  echo        3. Start the tunnel:      cloudflared tunnel --url http://localhost:4000
  echo        4. Open the https://*.trycloudflare.com URL it prints.
  echo.
  echo      Re-run this file after installing cloudflared and it will start the
  echo      tunnel for you automatically.
  echo.
  echo  LOCAL ACCESS still works: open http://localhost:4000
  pause
  exit /b 0
)

echo  [..] Starting public tunnel (https://*.trycloudflare.com)...
start "Pillbox Tunnel" cmd /k cloudflared tunnel --url http://localhost:4000
echo.
echo  ============================================================
echo   Done. In the "Pillbox Tunnel" window, open the
echo   https://XXXX.trycloudflare.com URL it prints.
echo   - Works from ANY device, anywhere (phone, another PC).
echo   - Webcam scanner + voice work (HTTPS = secure context).
echo   - ESP32 hardware still works (bridge uses localhost:4000).
echo  Close the "Pillbox Server" and "Pillbox Tunnel" windows to stop.
echo  ============================================================
echo.
pause
