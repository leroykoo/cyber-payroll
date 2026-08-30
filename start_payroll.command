#!/bin/zsh

set -e

PROJECT_DIR="${0:A:h}"
cd "$PROJECT_DIR"

if ! command -v python3 >/dev/null 2>&1; then
  echo "未找到 python3，请先安装 Python 3。"
  exit 1
fi

if [ ! -f "dist/index.html" ]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "尚未找到前端构建产物，且未找到 npm，请先安装 Node.js 后首次构建。"
    exit 1
  fi
  if [ ! -d "node_modules" ]; then
    echo "首次启动需要按照锁定版本安装前端依赖……"
    npm ci --ignore-scripts
  fi
  echo "正在生成前端发布构建……"
  npm run build
fi

if lsof -nP -iTCP:8787 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "127.0.0.1:8787 已被已有的本地后端占用。请先在原终端按 Ctrl+C 关闭服务，再重新运行本启动脚本。"
  exit 1
fi

echo "正在启动薪算台 Python 后端（127.0.0.1:8787）……"
python3 -c "from backend.payroll_app.local_api import serve; from pathlib import Path; serve(Path('.'))" &
BACKEND_PID=$!

cleanup() {
  echo "正在关闭薪算台服务……"
  kill "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "正在启动薪算台前端静态服务（127.0.0.1:5173）……"
python3 -m http.server 5173 --bind 127.0.0.1 --directory dist
