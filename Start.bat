@echo off
setlocal
title Nurse Status Board
cd /d "%~dp0"

set "NODE=node"
where node >nul 2>nul || set "NODE=%~dp0..\tools\node\node.exe"
if not "%NODE%"=="node" if not exist "%NODE%" (
    echo Could not find Node.js. Expected it at %NODE%
    pause
    exit /b 1
)

if not exist ".env" (
    copy /y ".env.example" ".env" >nul
    echo Created .env. Set NURSE_EMAIL and NURSE_PASSWORD in it, save, then run Start.bat again.
    start "" notepad ".env"
    pause
    exit /b 0
)

set "PORT=8090"
for /f "tokens=1,* delims==" %%a in ('findstr /b /c:"PORT=" ".env"') do if not "%%b"=="" set "PORT=%%b"

rem Open the nurse page once the server has had a moment to start.
start "" /b powershell -NoProfile -Command "Start-Sleep 2; Start-Process 'http://localhost:%PORT%/nurse'; Start-Process 'http://localhost:%PORT%/'"

"%NODE%" dev-server.js

echo.
echo  The board stopped. If it says the port is in use, another copy is still running.
pause
