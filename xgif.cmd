@echo off
rem xgif launcher for Windows (keep this file ASCII-only and CRLF)
chcp 65001 >nul
title xgif
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [xgif] Node.js not found in PATH.
  echo        Install Node.js 18 or newer from https://nodejs.org/
  echo.
  pause
  exit /b 1
)

node "%~dp0xgif.mjs" %*
set "XGIF_EXIT=%ERRORLEVEL%"

rem Keep the window open when the file was double-clicked (cmd /c ...)
echo %cmdcmdline% | findstr /i /c:"%~nx0" >nul && pause
exit /b %XGIF_EXIT%
