@echo off
REM ============================================================
REM  Loz's World - HARD RESET
REM  - kills any node process holding port 7777
REM  - wipes node_modules + package-lock
REM  - reinstalls from package.json
REM  - starts the server
REM  - opens the browser
REM
REM  If Loz's World is misbehaving, double-click this. It will
REM  take ~90 seconds and bring everything back to a known-good
REM  state.
REM ============================================================
setlocal
cd /d "%~dp0"

echo.
echo  ============================================================
echo    LOZ'S WORLD HARD RESET
echo  ============================================================
echo.

REM 1. Kill any node.exe holding port 7777.
echo [1/5] Looking for any process on port 7777...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":7777" ^| findstr "LISTENING"') do (
    echo       Killing PID %%P
    taskkill /F /PID %%P >nul 2>nul
)

REM 2. Verify node is on PATH.
where node >nul 2>nul
if errorlevel 1 (
    echo [!] Node.js is not installed or not on PATH.
    echo     Install LTS from https://nodejs.org and re-run this file.
    pause
    exit /b 1
)

REM 3. Wipe node_modules and package-lock.
echo [2/5] Wiping node_modules and package-lock.json...
if exist node_modules (
    rmdir /s /q node_modules 2>nul
)
if exist package-lock.json del /q package-lock.json 2>nul

REM 4. Fresh npm install.
echo [3/5] Installing dependencies. About 90 seconds.
call npm install
if errorlevel 1 (
    echo [!] npm install failed. See messages above.
    pause
    exit /b 2
)

REM 5. Verify the critical dependencies actually installed.
echo [4/5] Verifying critical dependencies...
set OK=1
if not exist node_modules\three (echo [!] three is missing & set OK=0)
if not exist node_modules\es-module-shims (echo [!] es-module-shims is missing & set OK=0)
if not exist node_modules\bonjour-service (echo [!] bonjour-service is missing & set OK=0)
if not exist node_modules\express (echo [!] express is missing & set OK=0)
if "%OK%"=="0" (
    echo [!] Critical dependencies missing after install. Aborting.
    pause
    exit /b 3
)
echo       All critical deps installed.

REM 6. Start the server.
echo [5/5] Starting server on http://localhost:7777
start "" http://localhost:7777
node server.js
