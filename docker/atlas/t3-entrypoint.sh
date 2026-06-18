#!/bin/sh
# Atlas Vector t3 entrypoint: run the T3 server and (when ATLAS_AUTOPAIR=1) mint
# a long-lived pairing token and publish it SAME-ORIGIN at /atlas-autopair.json,
# so the Atlas login gate can auto-pair the browser via T3's existing
# `/pair#token=...` auto-submit. No T3 source changes — uses the stock
# `t3 auth pairing create` CLI. Runs from WORKDIR /repo/apps/server.
set -e

# Ensure the runner auth/config dirs exist on the shared volume so the Codex/
# Claude connect flow can write credentials (avoids the "CODEX_HOME ... does not
# exist" warning).
[ -n "${CODEX_HOME:-}" ] && mkdir -p "$CODEX_HOME"
[ -n "${CLAUDE_CONFIG_DIR:-}" ] && mkdir -p "$CLAUDE_CONFIG_DIR"

node dist/bin.mjs serve &
SERVER_PID=$!
trap 'kill -TERM "$SERVER_PID" 2>/dev/null' TERM INT

if [ "${ATLAS_AUTOPAIR:-}" = "1" ]; then
  (
    # Wait for the server to accept requests.
    i=0
    while [ "$i" -lt 60 ]; do
      if node -e "fetch('http://127.0.0.1:3773/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
        break
      fi
      i=$((i + 1))
      sleep 2
    done
    # Mint a 30-day pairing credential against the same SQLite store the server
    # uses, and extract the token (.credential) from the JSON output.
    TOKEN=$(node dist/bin.mjs auth pairing create --ttl 720h --json 2>/dev/null \
      | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).credential||'')}catch(e){}})")
    if [ -n "$TOKEN" ]; then
      mkdir -p dist/client
      printf '{"token":"%s"}' "$TOKEN" > dist/client/atlas-autopair.json
      echo "[atlas] auto-pair token published at /atlas-autopair.json (valid 30d)"
    else
      echo "[atlas] auto-pair: could not mint pairing token; falling back to manual pairing" >&2
    fi
  ) &
fi

wait "$SERVER_PID"
