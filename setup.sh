#!/bin/bash
# VerilogVisualization - 一键配置并启动脚本
# 支持 venv / conda / 系统 Python 三种环境
#
# 用法:
#   bash setup.sh [HOST] [PORT]
# 示例:
#   bash setup.sh                    # 本地模式 127.0.0.1:5000
#   bash setup.sh 0.0.0.0            # 监听所有网卡，端口 5000
#   bash setup.sh 0.0.0.0 8080      # 远程部署，绑定所有网卡的 8080 端口

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── 参数解析 ──────────────────────────────────────────────────────────
HOST="${1:-127.0.0.1}"
PORT="${2:-5000}"

echo -e "${CYAN}"
echo "╔══════════════════════════════════════╗"
echo "║     ⚡ VerilogVisualization  Setup    ║"
echo "╚══════════════════════════════════════╝"
echo -e "${NC}"

# ── 1. 检查并询问是否终止旧进程 ───────────────────────────────────────
OLD_PID=""
if command -v lsof &>/dev/null; then
    OLD_PID=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
elif command -v fuser &>/dev/null; then
    OLD_PID=$(fuser "${PORT}/tcp" 2>/dev/null | tr -s ' ' '\n' | grep -v '^$' | head -1 || true)
fi

if [ -n "$OLD_PID" ]; then
    echo -e "${YELLOW}⚠️  端口 $PORT 已被进程 $OLD_PID 占用。${NC}"
    read -r -p "   是否关闭该进程并继续？[y/N] " CONFIRM
    if [[ "$CONFIRM" =~ ^[Yy]$ ]]; then
        kill -9 $OLD_PID 2>/dev/null && echo -e "${YELLOW}🔄 已关闭旧服务 (PID: $OLD_PID)${NC}" || true
        sleep 0.5
    else
        echo -e "${RED}已取消。请手动释放端口 $PORT 后重试。${NC}"
        exit 1
    fi
fi

# ── 2. 找 Python 解释器 ────────────────────────────────────────────────
PYTHON=""
for cmd in python3 python python3.12 python3.11 python3.10 python3.9 python3.8; do
    if command -v "$cmd" &>/dev/null; then
        VER=$("$cmd" -c "import sys; v=sys.version_info; print(v.major*100+v.minor)" 2>/dev/null)
        if [ -n "$VER" ] && [ "$VER" -ge 308 ]; then
            PYTHON="$cmd"
            break
        fi
    fi
done

if [ -z "$PYTHON" ]; then
    echo -e "${RED}❌ 未找到 Python 3.8+，请先安装 Python${NC}"
    echo "   Ubuntu/Debian: sudo apt install python3 python3-venv"
    echo "   conda:         conda install python"
    exit 1
fi

echo -e "${GREEN}✓ Python: $($PYTHON --version 2>&1) → $(command -v $PYTHON)${NC}"

# ── 3. 设置虚拟环境 ────────────────────────────────────────────────────
if [ ! -d ".venv" ]; then
    echo "📦 创建虚拟环境 .venv ..."
    "$PYTHON" -m venv .venv
    echo -e "${GREEN}✓ 虚拟环境已创建${NC}"
fi

# 激活
# shellcheck disable=SC1091
source .venv/bin/activate
echo -e "${GREEN}✓ 虚拟环境已激活: $(python --version 2>&1)${NC}"

# ── 4. 安装依赖 ────────────────────────────────────────────────────────
echo "📦 安装依赖 (requirements.txt) ..."
pip install -q --upgrade pip
pip install -q -r requirements.txt
echo -e "${GREEN}✓ 依赖安装完成${NC}"

# ── 5. 准备目录 ────────────────────────────────────────────────────────
mkdir -p data

# ── 6. 启动 ───────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}════════════════════════════════════════${NC}"
echo -e "${GREEN}🌐 服务器地址: http://${HOST}:${PORT}${NC}"
echo -e "${CYAN}   按 Ctrl+C 停止服务器${NC}"
echo -e "${CYAN}════════════════════════════════════════${NC}"
echo ""

# 自动打开浏览器（若可用，仅本地部署时）
if [[ "$HOST" == "127.0.0.1" || "$HOST" == "localhost" ]]; then
    if command -v xdg-open &>/dev/null; then
        (sleep 1.2 && xdg-open "http://${HOST}:${PORT}") &
    elif command -v open &>/dev/null; then
        (sleep 1.2 && open "http://${HOST}:${PORT}") &
    fi
fi

cd src
VV_HOST="$HOST" VV_PORT="$PORT" python app.py
