#!/usr/bin/env bash
# Mint a fresh pairing token for the Atelier dev server and print the /pair URL.
# Used to give agents (or a second browser) access to the dev app without
# hand-copying a token from the authenticated session.
#
# Usage (from the atelier workspace root):
#   ./scripts/claude-pair.sh            # 24h default
#   ./scripts/claude-pair.sh 7d         # custom TTL
#
# Requires the dev server (bun dev) to be running against its default baseDir.

set -euo pipefail

cd "$(dirname "$0")/.."

TTL="${1:-24h}"

node apps/server/src/bin.ts auth pairing create \
  --dev-url http://localhost:5733 \
  --base-url http://localhost:5733 \
  --ttl "$TTL" \
  --label agent-dev \
  2>/dev/null \
  | awk '/^Pair URL:/ {print $3}'
