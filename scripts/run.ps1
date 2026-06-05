# Launch ShotComfy backend + frontend, each in its own window. PS 5.1 compatible.
$root = Split-Path -Parent $PSScriptRoot
$backend = Join-Path $root "backend"
$frontend = Join-Path $root "frontend"

$venvPy = Join-Path $backend ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) {
    Write-Host "Backend venv missing. Run .\scripts\setup.ps1 first."
    exit 1
}

Write-Host "Starting backend (FastAPI :8799)..."
Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "Set-Location '$backend'; & '$venvPy' -m uvicorn app.main:app --host 127.0.0.1 --port 8799 --reload"
)

Write-Host "Starting frontend (Vite :5173)..."
Start-Process powershell -ArgumentList @(
    "-NoExit", "-Command",
    "Set-Location '$frontend'; npm run dev"
)

Write-Host ""
Write-Host "Frontend: http://localhost:5173"
Write-Host "Backend:  http://127.0.0.1:8799/api/health"
Write-Host "(Make sure ComfyUI is running on :8188)"
