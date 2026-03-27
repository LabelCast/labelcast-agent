@echo off
setlocal

echo ╔══════════════════════════════════════════╗
echo ║       Zebra Print Agent - Startup        ║
echo ╚══════════════════════════════════════════╝

:: Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not in PATH.
    echo         Download from https://nodejs.org/
    pause
    exit /b 1
)

:: First run: install dependencies
if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

:: Copy .env if not present
if not exist ".env" (
    if exist ".env.example" (
        copy ".env.example" ".env" >nul
        echo [WARN] Created .env from .env.example
        echo        Please edit .env and set PRINTER_HOST and API_TOKEN
        echo        Then run this script again.
        notepad .env
        pause
        exit /b 0
    )
)

echo [INFO] Starting agent...
node src/server.js

pause
