@echo off
rem ===========================================================================
rem  Pillbox — one-click setup for a FRESH Windows laptop (no programs yet).
rem  Run this file by double-clicking it. It installs deps, builds the
rem  local database, and starts both servers in their own windows.
rem  Requires Node.js to be installed first (see requirements.txt).
rem ===========================================================================
cd /d "%~dp0"

echo.
echo  ============================================================
echo   Pillbox setup
echo  ============================================================
echo.

rem ---- 1) Make sure Node.js / npm are installed -------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo  [X] Node.js was not found.
  echo      Install it first from https://nodejs.org  (LTS, check "Add to PATH"),
  echo      then run this file again.
  pause
  exit /b 1
)
echo  [OK] Node.js is installed.
for /f "tokens=*" %%v in ('node -v') do echo       node %%v
for /f "tokens=*" %%v in ('npm -v')  do echo       npm  %%v
echo.

rem ---- 2) Install all project dependencies (needs internet) -------------------
echo  [..] Installing dependencies (this can take a minute)...
call npm install
if errorlevel 1 (
  echo  [X] npm install failed. Check your internet connection and try again.
  pause
  exit /b 1
)
echo  [OK] Dependencies installed.
echo.

rem ---- 3) Prepare the local database (SQLite, no external server) ----------
echo  [..] Generating Prisma client...
call npm run prisma:generate
echo  [OK] Prisma client ready.
echo.
echo  [..] Creating/updating local database...
call npm run prisma:migrate
echo  [OK] Database ready.
echo.

rem ---- 4) Start the two servers in their own windows --------------------------
echo  [..] Starting backend server  (http://localhost:4000)...
start "Pillbox Server" cmd /k npm run dev:server
echo  [..] Starting frontend client  (http://localhost:5173)...
start "Pillbox Client" cmd /k npm run dev:client

rem ---- 5) Give the servers a moment to boot, then open the app --------
echo.
echo  [..] Waiting for servers to start...
timeout /t 8 /nobreak >nul
echo  [OK] Opening the app in your browser...
start "" http://localhost:5173

echo.
echo  ============================================================
echo   Done! Two windows are now running:
echo     - "Pillbox Server"  (keep open — backend on :4000)
echo     - "Pillbox Client"  (keep open — frontend on :5173)
echo   Close those windows to stop the app.
echo  ============================================================
echo.
pause
