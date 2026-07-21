@echo off
setlocal
:: Run from this script's folder so it works no matter where you launch it from.
cd /d "%~dp0"

title Pillbox - Install & Run
cls
echo ============================================================
echo   Pillbox - install everything and run the app
echo ============================================================
echo.

:: ---- 1. Node.js check (download if missing) ----
where node >nul 2>nul
if errorlevel 1 (
  echo [..] Node.js not found - attempting to download Node.js LTS...
  if not exist "bin" mkdir bin
  powershell -NoProfile -Command "$base='https://nodejs.org/dist/latest-lts/'; $html=(Invoke-WebRequest -Uri $base -UseBasicParsing).Content; $m=[regex]::Match($html,'node-v[0-9]+\.[0-9]+\.[0-9]+-win-x64\.zip'); if(-not $m.Success){exit 2}; $url=$base+$m.Value; Write-Host ('Downloading '+$url); Invoke-WebRequest -Uri $url -OutFile 'bin\node.zip'; Expand-Archive -Path 'bin\node.zip' -DestinationPath 'bin' -Force; Remove-Item 'bin\node.zip'"
  if errorlevel 1 (
    echo [X] Could not auto-download Node.js.
    echo     Install the LTS version from https://nodejs.org first, then re-run this file.
    pause
    exit /b 1
  )
  for /d %%d in ("bin\node-v*") do set "PATH=%~dp0%%d;%PATH%"
  echo [OK] Node.js downloaded and added to PATH for this session.
)
for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo [OK] Node.js %NODE_VER% found.

:: ---- 2. Make sure server/.env exists ----
if not exist "server\.env" (
  if exist "server\.env.example" (
    echo [..] server/.env missing - creating from .env.example
    copy "server\.env.example" "server\.env" >nul
    echo [!!] IMPORTANT: open server/.env and set ELEVENLABS_API_KEY and a random JWT_SECRET
    echo     before publishing. (Local use works with the defaults.)
  ) else (
    echo [X] server/.env.example not found - cannot continue.
    pause
    exit /b 1
  )
) else (
  echo [OK] server/.env present.
)

:: ---- 3. Install dependencies (workspaces: client, server, hardware-bridge) ----
echo [..] Installing dependencies (this can take a few minutes)...
call npm install
if errorlevel 1 (
  echo [X] npm install failed.
  pause
  exit /b 1
)
echo [OK] Dependencies installed.

:: ---- 4. Prisma client + database ----
echo [..] Generating Prisma client...
call npm run prisma:generate -w server
if errorlevel 1 (
  echo [X] Prisma client generation failed.
  pause
  exit /b 1
)

echo [..] Creating/updating the database (SQLite)...
pushd server
call npx prisma db push --accept-data-loss
set PRISMA_ERR=%errorlevel%
popd
if %PRISMA_ERR% neq 0 (
  echo [X] Database setup failed.
  pause
  exit /b 1
)
echo [OK] Database ready.

:: ---- 5. Build the web client (creates client/dist) ----
echo [..] Building the web app...
call npm run build -w client
if errorlevel 1 (
  echo [X] Client build failed.
  pause
  exit /b 1
)
echo [OK] App built.

:: ---- 6. Make sure cloudflared is available (for public access) ----
set "CLOUDFLARED=cloudflared"
where cloudflared >nul 2>nul
if errorlevel 1 (
  if not exist "bin" mkdir bin
  if not exist "bin\cloudflared.exe" (
    echo [..] cloudflared not found - downloading Windows binary...
    powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile 'bin\cloudflared.exe'"
    if errorlevel 1 (
      echo [!!] Could not auto-download cloudflared (no internet?).
      echo     Install it manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install/
      echo     The app will still run locally; the public tunnel is optional.
      set "CLOUDFLARED="
    )
  ) else (
    echo [..] Using downloaded cloudflared.
    set "CLOUDFLARED=%~dp0bin\cloudflared.exe"
  )
)
if defined CLOUDFLARED echo [OK] cloudflared available.

:: ---- 7. Run backend, then optionally start the public tunnel ----
echo [..] Starting backend...
start "Pillbox Backend" cmd /c "npm run dev:server"

:: Wait for the backend to be healthy (up to ~30s).
set /a TRIES=0
:waithealth
powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri http://localhost:4000/api/health -UseBasicParsing).Content | Out-Null } catch { exit 1 }" >nul 2>nul
if errorlevel 1 (
  set /a TRIES+=1
  if %TRIES% geq 30 (
    echo [X] Backend did not start in time. Check the "Pillbox Backend" window.
    pause
    exit /b 1
  )
  timeout /t 1 >nul >nul
  goto waithealth
)
echo [OK] Backend is up at http://localhost:4000

if defined CLOUDFLARED (
  echo.
  set /p PUB=Start the public Cloudflare tunnel now? (Y/N): 
  if /i "%PUB%"=="Y" (
    echo [..] Starting cloudflared tunnel (this prints your public URL)...
    "%CLOUDFLARED%" tunnel --url http://localhost:4000
  ) else (
    echo Local server running. Open http://localhost:4000
    echo (To go public later, run: cloudflared tunnel --url http://localhost:4000)
    pause
  )
) else (
  echo Local server running. Open http://localhost:4000
  echo (Install cloudflared to publish: cloudflared tunnel --url http://localhost:4000)
  pause
)

endlocal
