@echo off
rem Drag a .dump backup file onto this file, or run it and choose from the list
if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0runtime\scripts\restore.ps1"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0runtime\scripts\restore.ps1" -File "%~1"
)
if not defined BIDDING_NO_PAUSE pause
