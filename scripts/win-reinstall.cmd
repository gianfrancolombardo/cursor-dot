@echo off
setlocal EnableExtensions

rem Rebuild and reinstall Cursor Dot on Windows.
rem Usage:
rem   scripts\win-reinstall.cmd
rem   scripts\win-reinstall.cmd --portable
rem   scripts\win-reinstall.cmd --dir

cd /d "%~dp0.."

where npm >nul 2>nul
if errorlevel 1 (
  echo [error] npm not found. Install Node.js 18+ and retry.
  exit /b 1
)

echo [1/4] Installing dependencies...
call npm install
if errorlevel 1 exit /b 1

if /I "%~1"=="--portable" (
  echo [2/4] Building portable exe...
  call npm run dist:portable
) else if /I "%~1"=="--dir" (
  echo [2/4] Building unpacked dir...
  call npm run pack
) else (
  echo [2/4] Building NSIS installer...
  call npm run dist
)
if errorlevel 1 exit /b 1

echo [3/4] Installing Cursor hooks for this checkout...
call npm run install-hooks
if errorlevel 1 exit /b 1

echo [4/4] Done.
echo.
echo Next:
echo   - Installer: run the newest file in dist\
echo   - Or start unpacked: npm start
echo   - Then restart Cursor so hooks reload.
echo.
echo To uninstall later:
echo   - Settings ^> Apps ^> Cursor Dot ^> Uninstall
echo   - Or: npm run uninstall-hooks
exit /b 0
