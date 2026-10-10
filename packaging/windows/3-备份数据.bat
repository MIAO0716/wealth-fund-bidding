@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0runtime\scripts\backup.ps1"
if not defined BIDDING_NO_PAUSE pause
