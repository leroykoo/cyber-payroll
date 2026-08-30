@echo off
setlocal

cd /d "%~dp0"

if not exist "dist\index.html" (
  where npm >nul 2>nul
  if errorlevel 1 (
    echo 尚未找到前端构建产物，且未找到 npm，请先安装 Node.js 后首次构建。
    pause
    exit /b 1
  )
  if not exist "node_modules" (
    echo 首次启动需要按照锁定版本安装前端依赖……
    call npm ci --ignore-scripts
    if errorlevel 1 (
      echo 前端依赖安装失败。
      pause
      exit /b 1
    )
  )
  echo 正在生成前端发布构建……
  call npm run build
  if errorlevel 1 (
    echo 前端构建失败。
    pause
    exit /b 1
  )
)

where py >nul 2>nul
if not errorlevel 1 (
  set "PYTHON_CMD=py -3"
) else (
  where python >nul 2>nul
  if errorlevel 1 (
    echo 未找到 Python 3，请先安装 Python 3 并加入 PATH。
    pause
    exit /b 1
  )
  set "PYTHON_CMD=python"
)

echo 正在启动薪算台 Python 后端（127.0.0.1:8787）……
start "薪算台 Python 后端" cmd /k "%PYTHON_CMD% -c ""from backend.payroll_app.local_api import serve; from pathlib import Path; serve(Path('.'))"""

echo 正在启动薪算台前端静态服务（127.0.0.1:5173）……
start "薪算台前端静态服务" cmd /k "%PYTHON_CMD% -m http.server 5173 --bind 127.0.0.1 --directory dist"

endlocal
