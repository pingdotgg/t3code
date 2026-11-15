#!/usr/bin/env bash
# Starts the whiteboard's own T3 Code instance: the one at the root of the repository this
# directory sits in.
set -euo pipefail

WB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
T3_DIR=$(cd "$WB_DIR/../.." && pwd)
T3_DATA=${T3_DATA:-$HOME/.whiteboard/t3-userdata}
T3_PORT=${T3_PORT:-6070}
T3_PROJECT=${T3_PROJECT:-$T3_DIR}

mkdir -p "$T3_DATA"
# Inherited T3 settings would point this instance at the personal installation.
unset T3_SERVICE_LAUNCHER_CONTEXT T3_BOOT_SERVICE_UNIT \
  T3CODE_PORT T3CODE_HOST T3CODE_HOME T3CODE_NO_BROWSER

# Agents inherit PATH, while Codex app-servers register the adjacent skill root at startup.
export PATH="$WB_DIR/tools/bin:$PATH"
# Claude names a manifest-less plugin after its directory; `whiteboard` keeps the skill id.
export T3CODE_CLAUDE_PLUGIN_ROOT="$WB_DIR"
export T3CODE_CODEX_SKILL_ROOT="$WB_DIR/skills"
export BASH_ENV="$WB_DIR/tools/agent-env.sh"
# Web mode bootstraps a thread for the cwd project and every page load jumps
# into it. The whiteboard wants the new-thread landing instead.
export T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false
export T3CODE_UNSAFE_NO_AUTH=1
# The board page frames /chat/ from its own origin.
export T3CODE_ALLOW_SAME_ORIGIN_FRAME=1
# exec keeps this PID, so `wb` finds its agent among the server's children.
export WB_CHAT_PID=$$

exec node "$T3_DIR/apps/server/src/bin.ts" start \
  --mode web \
  --host 127.0.0.1 \
  --port "$T3_PORT" \
  --base-dir "$T3_DATA" \
  --no-browser \
  "$T3_PROJECT"
