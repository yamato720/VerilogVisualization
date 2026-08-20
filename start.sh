#!/bin/bash
# Verilog Visualizer - 一键启动脚本
#
# 用法:
#   bash start.sh [HOST] [PORT]
# 示例:
#   bash start.sh                    # 本机 127.0.0.1:5000
#   bash start.sh 127.0.0.1 5500     # 指定端口
#   bash start.sh 0.0.0.0 8080      # 显式监听所有网卡
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
# shellcheck source=scripts/vv-wsl-host.sh
source "$SCRIPT_DIR/scripts/vv-wsl-host.sh"

# ── 参数解析 ──────────────────────────────────────────────────────────
HOST="${1:-127.0.0.1}"
PORT="${2:-5000}"
# 未显式指定端口时，避开 Windows 已占用的端口，否则 WSL localhost 转发进不去。
if [[ -z ${2:-} ]]; then
    PORT=$(vv_choose_forwardable_port "$PORT")
fi

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
echo "   浏览器访问: http://127.0.0.1:${PORT}"
echo "   按 Ctrl+C 停止"
echo "================================"

# ── 自动打开浏览器 ─────────────────────────────────────────────────────
vv_open_browser "http://127.0.0.1:${PORT}"

# ── 启动服务器 ─────────────────────────────────────────────────────────
cd src
VV_HOST="$HOST" VV_PORT="$PORT" python3 app.py

