#!/bin/bash
# Verilog Visualizer - 一键启动脚本
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "⚡ Verilog Visualizer 启动中..."
echo "================================"

# Kill existing server on port 5000 (if any)
if command -v fuser &>/dev/null; then
    fuser -k 5000/tcp 2>/dev/null && echo "🔄 已关闭旧服务器 (端口 5000)" || true
elif command -v lsof &>/dev/null; then
    PID=$(lsof -ti tcp:5000 2>/dev/null)
    if [ -n "$PID" ]; then
        kill -9 $PID 2>/dev/null && echo "🔄 已关闭旧服务器 (PID: $PID)" || true
    fi
else
    # Fallback: kill any python3 app.py processes
    pkill -f "python3.*app\.py" 2>/dev/null && echo "🔄 已关闭旧服务器" || true
fi
sleep 0.5

# Check Python
if ! command -v python3 &>/dev/null; then
    echo "❌ 未找到 python3，请先安装 Python 3.8+"
    exit 1
fi

# Create virtual environment if not exists
if [ ! -d ".venv" ]; then
    echo "📦 创建虚拟环境..."
    python3 -m venv .venv
fi

# Activate
source .venv/bin/activate

# Install dependencies
echo "📦 检查依赖..."
pip install -q -r requirements.txt 2>/dev/null

# Create data dir
mkdir -p data

echo "================================"
echo "🌐 启动 Web 服务器: http://127.0.0.1:5000"
echo "   按 Ctrl+C 停止"
echo "================================"

# Open browser in background (if possible)
if command -v xdg-open &>/dev/null; then
    (sleep 1 && xdg-open "http://127.0.0.1:5000") &
elif command -v open &>/dev/null; then
    (sleep 1 && open "http://127.0.0.1:5000") &
fi

# Start server
cd src
python3 app.py
