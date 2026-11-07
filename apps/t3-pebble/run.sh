#!/bin/sh
set -eu
cd "$(dirname "$0")"
: "${T3_ORIGIN:?Set T3_ORIGIN to the T3 Code origin}"
export T3_MCP_URL="${T3_ORIGIN%/}/mcp"
if [ -f .mcp-token ]; then export T3_MCP_TOKEN="$(cat .mcp-token)"; fi
export T3_PEBBLE_TOKEN="$(cat .pebble-token)"
exec bun bridge/server.ts
