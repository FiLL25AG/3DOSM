# Uruchamia prototyp 3D OSM. Przy pierwszym starcie tworzy środowisko i pobiera dane sceny.
param([int]$Port = 8473)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
    python -m venv .venv
    & $python -m pip install -q -r requirements.txt
}
$env:PYTHONUTF8 = "1"
Write-Host "Aplikacja: http://127.0.0.1:$Port"
& $python -m server.app --port $Port
