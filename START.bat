@echo off
chcp 65001 >nul
title Shira Coach
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
)
echo Building...
call npm run build
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)
start "" http://localhost:4591/
call npm run preview
