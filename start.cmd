@echo off
rem Uruchamia prototyp 3D OSM dwuklikiem (omija blokadę skryptów .ps1 pobranych z internetu).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
if errorlevel 1 pause
