#!/usr/bin/env bash
#
# pair-mobile.sh — One command to connect the T3 Code mobile app to your
# locally-running server from any network.
#
# It will:
#   1. Find your running T3 Code server (loopback) — e.g. the desktop app.
#   2. Resolve your Mac's Tailscale IP (falls back to LAN IP).
#   3. Ensure a thin TCP proxy bridges  tailnet:PROXY_PORT -> 127.0.0.1:SERVER_PORT
#      (needed because the desktop server only binds 127.0.0.1).
#   4. Mint a fresh one-time pairing token.
#   5. Print the HOST and PAIRING CODE to paste into "Add Environment".
#
# Usage:
#   scripts/pair-mobile.sh                 # detect + bridge + mint, print HOST/CODE
#   scripts/pair-mobile.sh --ttl 6h        # longer-lived pairing token
#   scripts/pair-mobile.sh --server-port 3773 --proxy-port 3780
#   scripts/pair-mobile.sh --lan           # use LAN IP instead of Tailscale
#   scripts/pair-mobile.sh --stop          # stop the bridge proxy and exit
#
set -euo pipefail

# ---- defaults ---------------------------------------------------------------
SERVER_PORT=3773      # port your local T3 Code server listens on (loopback)
PROXY_PORT=3780       # port the bridge exposes on the tailnet/LAN
TTL="2h"              # pairing-token lifetime (e.g. 30m, 2h, 1d)
FORCE_LAN=0
DO_STOP=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$REPO_ROOT/apps/server"
PROXY_JS="${TMPDIR:-/tmp}/t3-tailnet-proxy.cjs"
PROXY_LOG="${TMPDIR:-/tmp}/t3-tailnet-proxy.log"
TAILSCALE_BIN="/Applications/Tailscale.app/Contents/MacOS/Tailscale"

export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

# ---- pretty output ----------------------------------------------------------
if [ -t 1 ]; then BOLD=$'\033[1m'; DIM=$'\033[2m'; GRN=$'\033[32m'; YEL=$'\033[33m'; RED=$'\033[31m'; RST=$'\033[0m'; else BOLD=""; DIM=""; GRN=""; YEL=""; RED=""; RST=""; fi
info() { echo "${DIM}·${RST} $*"; }
ok()   { echo "${GRN}✓${RST} $*"; }
warn() { echo "${YEL}!${RST} $*" >&2; }
die()  { echo "${RED}✗ $*${RST}" >&2; exit 1; }

# ---- args -------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --ttl)         TTL="${2:?}"; shift 2;;
    --server-port) SERVER_PORT="${2:?}"; shift 2;;
    --proxy-port)  PROXY_PORT="${2:?}"; shift 2;;
    --lan)         FORCE_LAN=1; shift;;
    --stop)        DO_STOP=1; shift;;
    -h|--help)     sed -n '2,30p' "$0"; exit 0;;
    *)             die "Unknown argument: $1 (try --help)";;
  esac
done

port_pid() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1; }

stop_proxy() {
  local pid; pid="$(port_pid "$PROXY_PORT" || true)"
  if [ -n "${pid:-}" ]; then
    kill "$pid" 2>/dev/null && ok "Stopped bridge proxy on :$PROXY_PORT (pid $pid)."
  else
    info "No bridge proxy running on :$PROXY_PORT."
  fi
}

if [ "$DO_STOP" -eq 1 ]; then stop_proxy; exit 0; fi

# ---- 1. local server --------------------------------------------------------
SERVER_CODE="$(curl -sS -m 8 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${SERVER_PORT}/" 2>/dev/null || echo 000)"
if [ "$SERVER_CODE" = "000" ]; then
  die "No T3 Code server answering on 127.0.0.1:${SERVER_PORT}.
   Start the desktop app (or run the server), then re-run this script.
   Override the port with --server-port <port>."
fi
ok "Local T3 Code server is up on 127.0.0.1:${SERVER_PORT} (HTTP ${SERVER_CODE})."

# ---- 2. reachable IP --------------------------------------------------------
HOST_IP=""
if [ "$FORCE_LAN" -eq 0 ] && [ -x "$TAILSCALE_BIN" ]; then
  HOST_IP="$("$TAILSCALE_BIN" ip -4 2>/dev/null | head -1 || true)"
  if [ -n "$HOST_IP" ]; then
    ok "Tailscale IP: ${HOST_IP} (reachable from any network on your tailnet)."
  else
    warn "Tailscale installed but not connected; falling back to LAN IP."
  fi
fi
if [ -z "$HOST_IP" ]; then
  HOST_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  [ -n "$HOST_IP" ] || die "Could not determine a Tailscale or LAN IP for this Mac."
  warn "Using LAN IP ${HOST_IP} — phone must be on the SAME network as this Mac."
fi

# ---- 3. bridge proxy --------------------------------------------------------
proxy_fwd() { [ "$(curl -sS -m 6 -o /dev/null -w '%{http_code}' "http://${HOST_IP}:${PROXY_PORT}/" 2>/dev/null || echo 000)" != "000" ]; }
# A healthy bridge needs BOTH a live listener PID and a working forward — guarding
# against a just-killed socket that still answers briefly (false "already live").
proxy_ok() { [ -n "$(port_pid "$PROXY_PORT" || true)" ] && proxy_fwd; }

if proxy_ok; then
  ok "Bridge already live: ${HOST_IP}:${PROXY_PORT} -> 127.0.0.1:${SERVER_PORT}."
else
  existing="$(port_pid "$PROXY_PORT" || true)"
  [ -z "${existing:-}" ] || die "Port ${PROXY_PORT} is in use (pid ${existing}) but not forwarding. Pick another with --proxy-port."

  cat > "$PROXY_JS" <<'NODE'
const net = require("net");
const LISTEN_PORT = Number(process.env.LISTEN_PORT);
const TARGET_PORT = Number(process.env.TARGET_PORT);
const server = net.createServer((client) => {
  const up = net.connect(TARGET_PORT, "127.0.0.1");
  client.on("error", () => up.destroy());
  up.on("error", () => client.destroy());
  client.pipe(up); up.pipe(client);
});
server.on("error", (e) => { console.error("proxy error:", e.message); process.exit(1); });
server.listen(LISTEN_PORT, "0.0.0.0", () =>
  console.log(`t3 tailnet proxy on 0.0.0.0:${LISTEN_PORT} -> 127.0.0.1:${TARGET_PORT}`));
NODE

  LISTEN_PORT="$PROXY_PORT" TARGET_PORT="$SERVER_PORT" \
    nohup node "$PROXY_JS" > "$PROXY_LOG" 2>&1 < /dev/null &
  disown || true

  for _ in 1 2 3 4 5 6 7 8 9 10; do proxy_ok && break; sleep 0.5; done
  proxy_ok || die "Bridge proxy failed to start. See ${PROXY_LOG}."
  ok "Started bridge proxy: ${HOST_IP}:${PROXY_PORT} -> 127.0.0.1:${SERVER_PORT} (log: ${PROXY_LOG})."
fi

# ---- 4. pairing token -------------------------------------------------------
[ -d "$SERVER_DIR" ] || die "Cannot find apps/server at ${SERVER_DIR}."
TOKEN_OUT="$(cd "$SERVER_DIR" && node src/bin.ts auth pairing create --ttl "$TTL" 2>/dev/null || true)"
CODE="$(printf '%s\n' "$TOKEN_OUT" | sed -n 's/^Token: //p' | head -1)"
EXPIRES="$(printf '%s\n' "$TOKEN_OUT" | sed -n 's/^Expires at: //p' | head -1)"
[ -n "$CODE" ] || die "Failed to mint a pairing token.
   Run manually: (cd ${SERVER_DIR} && node src/bin.ts auth pairing create --ttl ${TTL})"

HOST_URL="http://${HOST_IP}:${PROXY_PORT}"

# ---- 5. output --------------------------------------------------------------
echo
echo "${BOLD}── T3 Code · Add Environment ─────────────────────────${RST}"
echo "  ${BOLD}HOST${RST}          ${GRN}${HOST_URL}${RST}"
echo "  ${BOLD}PAIRING CODE${RST}  ${GRN}${CODE}${RST}"
echo "${BOLD}──────────────────────────────────────────────────────${RST}"
[ -n "$EXPIRES" ] && echo "  ${DIM}token expires: ${EXPIRES} (TTL ${TTL})${RST}"
echo "  ${DIM}open the T3 Code app → Add Environment → paste the two values above${RST}"
echo "  ${DIM}stop the bridge later with:  scripts/pair-mobile.sh --stop${RST}"
echo
