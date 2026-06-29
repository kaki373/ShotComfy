@echo off
chcp 65001 >nul
setlocal

rem ============================================================
rem ShotComfy launcher
rem   - Backend  (FastAPI/uvicorn): http://127.0.0.1:8799
rem   - Frontend (Vite):            http://127.0.0.1:5273
rem ComfyUI must be started separately: http://127.0.0.1:8188
rem ============================================================

set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"
set "FRONTEND=%ROOT%frontend"
set "PYTHON=%BACKEND%\.venv\Scripts\python.exe"

echo [ShotComfy] Starting...

if not exist "%PYTHON%" (
  echo [ERROR] Python venv was not found: %PYTHON%
  echo Run scripts\setup.ps1 first.
  pause
  exit /b 1
)

if not exist "%FRONTEND%\node_modules" (
  echo [ERROR] node_modules was not found: %FRONTEND%\node_modules
  echo Run npm.cmd install in the frontend folder first.
  pause
  exit /b 1
)

start "ShotComfy Backend" /D "%BACKEND%" cmd /k ".venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8799 --reload"
start "ShotComfy Frontend" /D "%FRONTEND%" cmd /k "npm.cmd run dev"

echo [ShotComfy] Waiting for frontend...
timeout /t 5 /nobreak >nul
start "" "http://127.0.0.1:5273/"

echo.
echo [ShotComfy] Started Backend and Frontend windows.
echo   App:     http://127.0.0.1:5273/
echo   Backend: http://127.0.0.1:8799/api/health
echo.
echo Close the Backend / Frontend command windows, or run stop.bat, to stop ShotComfy.
endlocal
