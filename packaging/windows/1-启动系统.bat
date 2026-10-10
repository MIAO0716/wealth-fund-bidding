@echo off
rem Start the bidding system (first run installs and initializes automatically)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0runtime\scripts\start.ps1"
if errorlevel 1 pause
