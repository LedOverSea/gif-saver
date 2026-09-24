@echo off
rem xgif UI launcher for Windows (keep this file ASCII-only and CRLF)
chcp 65001 >nul
title xgif UI
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [xgif] Node.js not found in PATH.
  echo        Install Node.js 18 or newer from https://nodejs.org/
  echo.
  pause
  exit /b 1
)

node "%~dp0ui.mjs" %*
set "XGIF_EXIT=%ERRORLEVEL%"

rem Keep the window open if the server failed to start
if not "%XGIF_EXIT%"=="0" pause
exit /b %XGIF_EXIT%
