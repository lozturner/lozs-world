@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :no_node

if not exist node_modules goto :install_deps
if not exist node_modules\bonjour-service goto :install_deps
if not exist node_modules\three goto :install_deps
if not exist node_modules\es-module-shims goto :install_deps
goto :start_server

:no_node
echo [!] Node.js is not installed or not on PATH.
echo     Install LTS from https://nodejs.org then re-run this file.
pause
exit /b 1

:install_deps
echo [+] Installing / updating dependencies. About 60 seconds first time.
call npm install
if errorlevel 1 goto :npm_failed
goto :start_server

:npm_failed
echo [!] npm install failed. See messages above.
pause
exit /b 2

:start_server
echo [+] Starting server on http://localhost:7777
start "" http://localhost:7777
:server_loop
node server.js
if %errorlevel% equ 99 (
    echo [+] server.js changed - restarting...
    goto :server_loop
)
echo [+] Server stopped (exit %errorlevel%).
pause
