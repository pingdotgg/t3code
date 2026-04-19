#!/data/data/com.termux/files/usr/bin/sh
set -eu

T3CODE_TERMUX_DIR="${T3CODE_TERMUX_DIR:-$HOME/t3code-termux}"
T3CODE_VERSION="${T3CODE_VERSION:-latest}"
T3CODE_WORKSPACE="${T3CODE_WORKSPACE:-$HOME}"
T3CODE_HOST="${T3CODE_HOST:-127.0.0.1}"
T3CODE_PORT="${T3CODE_PORT:-8787}"
T3CODE_INSTALL_CODEX="${T3CODE_INSTALL_CODEX:-auto}"

log() {
  printf '%s\n' "==> $*"
}

fail() {
  printf '%s\n' "error: $*" >&2
  exit 1
}

if ! command -v pkg >/dev/null 2>&1; then
  fail "This installer must run inside Termux."
fi

if [ -z "${PREFIX:-}" ] || [ ! -d "$PREFIX" ]; then
  fail "PREFIX is not set. Start a normal Termux shell and run this again."
fi

case "$(uname -m)" in
  aarch64|arm64) ;;
  *) fail "T3 Code on Termux is currently tested on Android ARM64 only." ;;
esac

log "Installing Termux packages"
pkg update -y
pkg install -y git clang make python pkg-config

node_version_ok() {
  command -v node >/dev/null 2>&1 && node -e '
const [major, minor] = process.versions.node.split(".").map(Number);
const ok = (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || (major === 24 && minor >= 10) || major > 24;
if (!ok) {
  console.error(`T3 Code requires Node.js 22.16+, 23.11+, or 24.10+. Current: ${process.versions.node}`);
  process.exit(1);
}
'
}

log "Checking Node.js"
if ! node_version_ok; then
  log "Installing Node.js LTS"
  pkg install -y nodejs-lts
  node_version_ok
fi

if [ "$T3CODE_INSTALL_CODEX" != "0" ] && [ "$T3CODE_INSTALL_CODEX" != "false" ]; then
  if command -v codex >/dev/null 2>&1; then
    log "Codex CLI already installed: $(codex --version 2>/dev/null || printf unknown)"
  else
    log "Installing the Termux Codex CLI fork"
    npm install -g @mmmbuto/codex-cli-termux@latest
  fi
fi

log "Creating T3 Code install at $T3CODE_TERMUX_DIR"
mkdir -p "$T3CODE_TERMUX_DIR"
cd "$T3CODE_TERMUX_DIR"

if [ ! -f package.json ]; then
  npm init -y >/dev/null
  npm pkg set name=t3code-termux >/dev/null
  npm pkg set private=true --json >/dev/null
fi

log "Installing t3@$T3CODE_VERSION with Android native build settings"
npm_config_android_ndk_path="$PREFIX" npm install "t3@$T3CODE_VERSION"

log "Writing helper npm scripts"
npm pkg set "scripts.start=t3 start --host $T3CODE_HOST --port $T3CODE_PORT --no-browser $T3CODE_WORKSPACE" >/dev/null
npm pkg set "scripts.serve=t3 serve --host $T3CODE_HOST --port $T3CODE_PORT $T3CODE_WORKSPACE" >/dev/null
npm pkg set "scripts.rebuild-native=npm_config_android_ndk_path=$PREFIX npm rebuild node-pty msgpackr-extract --build-from-source" >/dev/null

log "Installed $(./node_modules/.bin/t3 --version)"
printf '\n'
printf '%s\n' "Next steps:"
printf '%s\n' "  1. Authenticate Codex if needed: codex login"
printf '%s\n' "  2. Start T3 Code: cd $T3CODE_TERMUX_DIR && npm start"
printf '%s\n' "  3. Open the printed pairing URL in Android browser."
printf '\n'
printf '%s\n' "Default URL after startup: http://$T3CODE_HOST:$T3CODE_PORT"
