#!/bin/bash
# Verilog Visualizer - 一键启动脚本
#
# 用法:
#   bash start.sh [HOST] [PORT]
# 示例:
#   bash start.sh                    # 本地模式 127.0.0.1:5000
#   bash start.sh 0.0.0.0            # 监听所有网卡，端口 5000
#   bash start.sh 0.0.0.0 8080      # 远程部署，绑定所有网卡的 8080 端口
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ── 参数解析 ──────────────────────────────────────────────────────────
HOST="${1:-127.0.0.1}"
PORT="${2:-5000}"

echo "⚡ Verilog Visualizer 启动中..."
echo "================================"

# ── 检查并询问是否终止占用指定端口的旧进程 ──────────────────────────────
OLD_PID=""
if command -v lsof &>/dev/null; then
    OLD_PID=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
elif command -v fuser &>/dev/null; then
    OLD_PID=$(fuser "${PORT}/tcp" 2>/dev/null | tr -s ' ' '\n' | grep -v '^$' | head -1 || true)
else
    OLD_PID=$(pgrep -f "python3.*app\.py" 2>/dev/null | head -1 || true)
fi

if [ -n "$OLD_PID" ]; then
    echo "⚠️  端口 $PORT 已被进程 $OLD_PID 占用。"
    read -r -p "   是否关闭该进程并继续？[y/N] " CONFIRM
    if [[ "$CONFIRM" =~ ^[Yy]$ ]]; then
        kill -9 $OLD_PID 2>/dev/null && echo "🔄 已关闭旧服务器 (PID: $OLD_PID)" || true
        sleep 0.5
    else
        echo "已取消。请手动释放端口 $PORT 后重试。"
        exit 1
    fi
fi

# ── 检查 Python ────────────────────────────────────────────────────────
if ! command -v python3 &>/dev/null; then
    echo "❌ 未找到 python3，请先安装 Python 3.8+"
    exit 1
fi

# ── 虚拟环境 ───────────────────────────────────────────────────────────
if [ ! -d ".venv" ]; then
    echo "📦 创建虚拟环境..."
    python3 -m venv .venv
fi

source .venv/bin/activate

# ── 安装依赖 ───────────────────────────────────────────────────────────
echo "📦 检查依赖..."
pip install -q -r requirements.txt 2>/dev/null

mkdir -p data

echo "================================"
echo "🌐 启动 Web 服务器: http://${HOST}:${PORT}"
echo "   按 Ctrl+C 停止"
echo "================================"

# ── 自动打开浏览器（仅本地部署时）──────────────────────────────────────
if [[ "$HOST" == "127.0.0.1" || "$HOST" == "localhost" ]]; then
    if command -v xdg-open &>/dev/null; then
        (sleep 1 && xdg-open "http://${HOST}:${PORT}") &
    elif command -v open &>/dev/null; then
        (sleep 1 && open "http://${HOST}:${PORT}") &
    fi
fi

# ── 启动服务器 ─────────────────────────────────────────────────────────
cd src
VV_HOST="$HOST" VV_PORT="$PORT" python3 app.py

