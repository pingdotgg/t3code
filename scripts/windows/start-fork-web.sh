#!/usr/bin/env bash
set -euo pipefail
repository=${1:?Repository path required}
port=${2:?Web port required}
export T3CODE_PORT=${3:?Backend port required}
action=${4:-start}
cd "$repository/apps/web"
export PATH="$HOME/.local/share/vite-plus/bin:$HOME/.local/bin:/home/linuxbrew/.linuxbrew/bin:$PATH"
export T3CODE_SINGLE_ORIGIN_DEV=1
export HOST=127.0.0.1
export PORT="$port"
unset VITE_HTTP_URL VITE_WS_URL VITE_DEV_SERVER_URL
node_binary=$(vp env which node)
vite_entry=$("$node_binary" -e 'const {createRequire}=require("node:module");const p=require("node:path");const q=createRequire(require.resolve("vite-plus"));console.log(p.resolve(p.dirname(q.resolve("vite")),"../bin/vite.js"));')
pid_file="$repository/.t3/windows-frontend-$port.pid"
if [[ "$action" == stop ]]; then
    [[ -f "$pid_file" ]] || exit 0
    read -r frontend_pid < "$pid_file"
    [[ "$frontend_pid" =~ ^[0-9]+$ ]] || exit 1
    if [[ -d "/proc/$frontend_pid" ]]; then
        [[ "$(readlink "/proc/$frontend_pid/cwd")" == "$repository/apps/web" ]] || exit 1
        mapfile -d '' -t command_args < "/proc/$frontend_pid/cmdline"
        [[ "${command_args[1]:-}" == "$vite_entry" && "${command_args[6]:-}" == "$port" ]] || exit 1
        kill -TERM "$frontend_pid"
    fi
    rm -f "$pid_file"
    exit 0
fi
[[ "$action" == start ]] || exit 1
mkdir -p "$repository/.t3"
printf '%s\n' "$$" > "$pid_file"
exec "$node_binary" "$vite_entry" dev --host 127.0.0.1 --port "$port" --strictPort
