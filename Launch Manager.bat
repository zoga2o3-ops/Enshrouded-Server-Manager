@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install || (echo npm install failed & pause & exit /b 1)
)
start "" node_modules\.bin\electron.cmd .
