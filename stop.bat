@echo off
chcp 932 >nul
setlocal enabledelayedexpansion

rem ============================================================
rem  ShotComfy 停止バッチ
rem   - バックエンド (8799) と フロントエンド (5273) を
rem     ポートを握っているプロセスだけ狙って停止します。
rem   - ComfyUI(8188) は対象外（別管理）。
rem ============================================================

echo [ShotComfy] 停止します...

call :killport 8799 backend
call :killport 5273 frontend

echo.
echo [ShotComfy] 完了しました。
echo このウィンドウは閉じてOKです。
timeout /t 3 /nobreak >nul
endlocal
exit /b 0

:killport
set "PORT=%~1"
set "LABEL=%~2"
set "FOUND="
for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  set "FOUND=1"
  echo   - stopping %LABEL% port %PORT% PID %%P
  taskkill /PID %%P /F >nul 2>&1
)
if not defined FOUND echo   - %LABEL% port %PORT% は起動していません
exit /b 0