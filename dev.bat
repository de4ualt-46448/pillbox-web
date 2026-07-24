@echo off
title Pillbox Web - Dev Server
cd /d "%~dp0"

echo.
echo ============================================
echo   PILLBOX WEB - ERROR CHECK ^& DEV START
echo ============================================
echo.

set HAS_ERROR=0

echo [1/4] Checking client TypeScript errors...
call .\node_modules\.bin\tsc --project client/tsconfig.json --noEmit
if %ERRORLEVEL% NEQ 0 (
    echo  ^>^> CLIENT HAS ERRORS
    set HAS_ERROR=1
) else (
    echo  ^> Client: OK
)
echo.

echo [2/4] Checking server TypeScript errors...
call .\node_modules\.bin\tsc --project server/tsconfig.json --noEmit
if %ERRORLEVEL% NEQ 0 (
    echo  ^>^> SERVER HAS ERRORS
    set HAS_ERROR=1
) else (
    echo  ^> Server: OK
)
echo.

echo [3/4] Checking hardware-bridge TypeScript errors...
call .\node_modules\.bin\tsc --project hardware-bridge/tsconfig.json --noEmit
if %ERRORLEVEL% NEQ 0 (
    echo  ^>^> HARDWARE-BRIDGE HAS ERRORS
    set HAS_ERROR=1
) else (
    echo  ^> Hardware-bridge: OK
)
echo.

if %HAS_ERROR% EQU 1 (
    echo ============================================
    echo   ERRORS DETECTED - Fix them before starting
    echo ============================================
    echo.
    echo   Press any key to close...
    pause >nul
    goto :eof
)

echo [4/4] All checks passed! Starting servers...
echo.

cd /d "%~dp0"

echo  Starting server (Express + MQTT)...
start "Pillbox-Server" cmd /k "cd /d C:\Users\Admin\projects\pillbox-web\server && npx tsx watch src/index.ts"

timeout /t 3 /nobreak >nul

echo  Starting client (Vite)...
start "Pillbox-Client" cmd /k "cd /d C:\Users\Admin\projects\pillbox-web\client && npx vite"

echo.
echo ============================================
echo   SERVERS ARE RUNNING
echo ============================================
echo.
echo   Server (API):         http://localhost:4000
echo   Client (UI):          http://localhost:5173
echo   MQTT TCP Broker:      mqtt://localhost:1883
echo   MQTT WebSocket:       ws://localhost:8888
echo   Hardware WebSocket:   ws://localhost:4000/ws/hardware
echo.
echo   Close the Server/Client windows to stop.
echo.
echo   Press any key to close this launcher window...
pause >nul
