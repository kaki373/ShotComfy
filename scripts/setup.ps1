# ShotComfy first-time setup (idempotent). Windows PowerShell 5.1 compatible.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Write-Host "ShotComfy repo: $root"

# --- config.json ---
$cfg = Join-Path $root "config.json"
if (-not (Test-Path $cfg)) {
    Copy-Item (Join-Path $root "config.example.json") $cfg
    Write-Host "[config] created config.json (edit paths for this PC)"
} else {
    Write-Host "[config] config.json already exists"
}

# --- backend venv + deps ---
$backend = Join-Path $root "backend"
$venvPy = Join-Path $backend ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
    Write-Host "[backend] creating venv..."
    python -m venv (Join-Path $backend ".venv")
} else {
    Write-Host "[backend] venv exists"
}
Write-Host "[backend] installing requirements..."
& $venvPy -m pip install --upgrade pip
& $venvPy -m pip install -r (Join-Path $backend "requirements.txt")

# --- frontend deps ---
$frontend = Join-Path $root "frontend"
if (Test-Path (Join-Path $frontend "package.json")) {
    Write-Host "[frontend] npm install..."
    Push-Location $frontend
    npm.cmd install
    Pop-Location
} else {
    Write-Host "[frontend] package.json not found yet - skipping npm install"
}

Write-Host ""
Write-Host "Setup done. Next:"
Write-Host "  1) edit config.json if needed"
Write-Host "  2) start ComfyUI (separate)"
Write-Host "  3) .\scripts\run.ps1   ->  open http://localhost:5273"
