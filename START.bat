@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title EmdadX Attendance
chcp 65001 >nul

where node >nul 2>nul
if errorlevel 1 goto :nonode

for /f "tokens=1,2 delims=." %%a in ('node -v') do (
  set "NODEMAJ=%%a"
  set "NODEMIN=%%b"
)
set "NODEMAJ=%NODEMAJ:v=%"
if %NODEMAJ% LSS 22 goto :oldnode
if %NODEMAJ% EQU 22 if %NODEMIN% LSS 5 goto :oldnode

if "%PORT%"=="" set "PORT=8686"

rem open the browser after the server has started
start "" /min cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:%PORT%/?admin"

node --experimental-sqlite --no-warnings server.js
echo.
echo  Server stopped.
pause
exit /b 0

:nonode
echo.
echo  [!] Node.js is not installed.
echo      Install Node.js 22 LTS (or newer) from https://nodejs.org then run START.bat again.
echo.
start "" https://nodejs.org/en/download
pause
exit /b 1

:oldnode
echo.
echo  [!] Your Node.js version is too old. Node.js 22.5 or newer is required.
echo.
start "" https://nodejs.org/en/download
pause
exit /b 1
