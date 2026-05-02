@echo off
setlocal

set "PROJECT_DIR=%~dp0"
set "WEB_DIR=%PROJECT_DIR%web"
set "PORT=4173"

echo Tiny IMU Trainer Web Service
echo Project: %PROJECT_DIR%
echo URL: http://127.0.0.1:%PORT%/trainer.html
echo.

where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm was not found. Please install Node.js first.
  pause
  exit /b 1
)

cd /d "%WEB_DIR%"
if errorlevel 1 (
  echo ERROR: Cannot enter web directory: %WEB_DIR%
  pause
  exit /b 1
)

echo Releasing port %PORT% if it is already in use...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ids=(Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); foreach($id in $ids){ if($id){ Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } }"

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo ERROR: npm install failed.
    pause
    exit /b 1
  )
)

echo Building frontend and trainer...
call npm run build
if errorlevel 1 (
  echo ERROR: frontend build failed.
  pause
  exit /b 1
)

echo Starting local trainer server...
start "" "http://127.0.0.1:%PORT%/trainer.html"
call npm run start -- --host 127.0.0.1 --port %PORT%

endlocal
