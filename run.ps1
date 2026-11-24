# Uruchamia prototyp 3D OSM. Przy pierwszym starcie tworzy środowisko i pobiera dane sceny.
param([int]$Port = 8473)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
$ready = Join-Path $PSScriptRoot ".venv\.installed"

function Find-BasePython {
    # Szuka Pythona 3.12 lub nowszego: najpierw launcher py, potem python z PATH.
    $candidates = @()
    if (Get-Command py -ErrorAction SilentlyContinue) { $candidates += , @("py", "-3") }
    if (Get-Command python -ErrorAction SilentlyContinue) { $candidates += , @("python") }
    foreach ($c in $candidates) {
        $exe = $c[0]; $pre = @($c | Select-Object -Skip 1)
        $ver = & $exe @pre -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
        if ($LASTEXITCODE -eq 0 -and $ver -and [version]$ver -ge [version]"3.12") { return , $c }
    }
    return $null
}

if (-not (Test-Path $ready)) {
    $base = Find-BasePython
    if (-not $base) {
        Write-Host "Nie znaleziono Pythona 3.12 lub nowszego. Zainstaluj go z https://www.python.org/downloads/ i uruchom ponownie." -ForegroundColor Red
        exit 1
    }
    Write-Host "Pierwsze uruchomienie: tworzę środowisko i instaluję zależności..."
    $exe = $base[0]; $pre = @($base | Select-Object -Skip 1)
    & $exe @pre -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw "Nie udało się utworzyć środowiska .venv." }
    & $python -m pip install -q -r requirements.txt
    if ($LASTEXITCODE -ne 0) { throw "Instalacja zależności nie powiodła się. Sprawdź połączenie z internetem i uruchom ponownie." }
    New-Item -ItemType File $ready | Out-Null
}
$env:PYTHONUTF8 = "1"
Write-Host "Aplikacja: http://127.0.0.1:$Port"
& $python -m server.app --port $Port
