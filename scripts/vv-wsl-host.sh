# VerilogVisualization 启动辅助：WSL localhost 转发与打开浏览器。
# 不修改 Windows 系统代理、WinHTTP、.wslconfig 或环境变量里的 HTTP(S)_PROXY。

vv_is_wsl() {
  [[ -n ${WSL_INTEROP:-} ]] || grep -qi microsoft /proc/version 2>/dev/null
}

vv_windows_listener() {
  local port=$1
  command -v powershell.exe >/dev/null 2>&1 || return 1
  powershell.exe -NoProfile -Command "
    \$c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if (-not \$c) { exit 1 }
    \$p = Get-Process -Id \$c.OwningProcess -ErrorAction SilentlyContinue
    if (\$p) { Write-Output \$p.ProcessName } else { Write-Output unknown }
    exit 0
  " 2>/dev/null | tr -d '\r'
}

vv_linux_port_busy() {
  local port=$1
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -Eq ":${port}[[:space:]]"
  else
    : "${port:?}"
    return 1
  fi
}

# 默认端口在 Windows 侧已被占用时，换一个两端都空闲的端口，否则 WSL localhost 转发无法挂上。
vv_choose_forwardable_port() {
  local port=$1 candidate owner i
  if ! vv_is_wsl; then
    printf '%s\n' "$port"
    return 0
  fi
  for i in $(seq 0 20); do
    candidate=$((port + i))
    if vv_linux_port_busy "$candidate"; then
      continue
    fi
    owner=$(vv_windows_listener "$candidate" || true)
    if [[ -n $owner ]]; then
      if (( i == 0 )); then
        echo "Windows 的 127.0.0.1:${candidate} 已被 ${owner} 占用，WSL 无法转发该端口。" >&2
      fi
      continue
    fi
    if (( candidate != port )); then
      echo "改用端口 ${candidate}，Windows 浏览器打开 http://127.0.0.1:${candidate}" >&2
    fi
    printf '%s\n' "$candidate"
    return 0
  done
  printf '%s\n' "$port"
}

vv_open_browser() {
  local url=$1
  (
    sleep 1
    if [[ -n ${BROWSER:-} ]]; then
      "$BROWSER" "$url" >/dev/null 2>&1 && exit 0
    fi
    if vv_is_wsl; then
      # 沿用当前用户代理，只打开页面，不加 --proxy-* 以免改掉这次 Chrome 进程的代理行为。
      for candidate in \
        "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" \
        "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"; do
        if [[ -x $candidate ]]; then
          "$candidate" "$url" >/dev/null 2>&1 && exit 0
        fi
      done
      if command -v cmd.exe >/dev/null 2>&1; then
        cmd.exe /c start "" "$url" >/dev/null 2>&1 && exit 0
      fi
    fi
    if command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$url" >/dev/null 2>&1 && exit 0
    fi
    if command -v open >/dev/null 2>&1; then
      open "$url" >/dev/null 2>&1 && exit 0
    fi
  ) &
}
