

export const REMOTE_NODE_ENV_SCRIPT = `prepend_path_if_dir() {
  if [ -d "$1" ]; then
    case ":$PATH:" in
      *":$1:"*) ;;
      *) PATH="$1:$PATH" ;;
    esac
  fi
}

remote_node_satisfies_engine() {
  T3_NODE_ENGINE_RANGE=@@T3_NODE_ENGINE_RANGE@@
  if [ -z "$T3_NODE_ENGINE_RANGE" ]; then
    return 0
  fi
  node - "$T3_NODE_ENGINE_RANGE" <<'NODE'
@@T3_NODE_ENGINE_CHECK_SCRIPT@@
NODE
}

ensure_remote_node_path() {
  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then
    return 0
  fi

  prepend_path_if_dir "$HOME/.local/bin"
  prepend_path_if_dir "$HOME/bin"
  prepend_path_if_dir "/opt/homebrew/bin"
  prepend_path_if_dir "/home/linuxbrew/.linuxbrew/bin"
  prepend_path_if_dir "/usr/local/bin"
  prepend_path_if_dir "/usr/bin"
  prepend_path_if_dir "/bin"

  if [ -z "\${VOLTA_HOME:-}" ]; then
    VOLTA_HOME="$HOME/.volta"
  fi
  export VOLTA_HOME
  prepend_path_if_dir "$VOLTA_HOME/bin"

  prepend_path_if_dir "$HOME/.asdf/shims"
  prepend_path_if_dir "$HOME/.asdf/bin"
  if [ ! -x "$HOME/.asdf/shims/node" ] && [ -s "$HOME/.asdf/asdf.sh" ]; then
    # shellcheck disable=SC1090
    . "$HOME/.asdf/asdf.sh"
  fi

  prepend_path_if_dir "$HOME/.local/share/mise/shims"
  prepend_path_if_dir "$HOME/.mise/shims"
  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then
    eval "$(mise activate sh)" >/dev/null 2>&1 || true
  fi

  if [ -z "\${FNM_DIR:-}" ]; then
    FNM_DIR="$HOME/.local/share/fnm"
  fi
  export FNM_DIR
  prepend_path_if_dir "$FNM_DIR"
  prepend_path_if_dir "$HOME/.fnm"
  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env --shell bash)" >/dev/null 2>&1 || true
    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true
  fi

  prepend_path_if_dir "$HOME/.nodenv/bin"
  prepend_path_if_dir "$HOME/.nodenv/shims"
  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then
    eval "$(nodenv init -)" >/dev/null 2>&1 || true
  fi

  if [ -z "\${NVM_DIR:-}" ]; then
    NVM_DIR="$HOME/.nvm"
  fi
  export NVM_DIR

  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then
      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true
    fi
  fi

  if ! command -v node >/dev/null 2>&1 && [ -d "$NVM_DIR/versions/node" ]; then
    for T3_NODE_BIN in "$NVM_DIR"/versions/node/*/bin; do
      if [ -x "$T3_NODE_BIN/node" ]; then
        PATH="$T3_NODE_BIN:$PATH"
        export PATH
      fi
    done
  fi

  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine
}
`;

export const REMOTE_RUNNER_SCRIPT = `#!/bin/sh
set -eu
@@T3_NODE_ENV_SCRIPT@@
T3_NODE_SCRIPT_PATH=@@T3_NODE_SCRIPT_PATH@@
if [ -n "$T3_NODE_SCRIPT_PATH" ]; then
  # Dev mode: a source checkout on the remote. This is the only path that
  # needs Node, so Node discovery runs here and nowhere else.
  ensure_remote_node_path || true
  if ! command -v node >/dev/null 2>&1; then
    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2
    exit 1
  fi
  exec node "$T3_NODE_SCRIPT_PATH" "$@"
fi
T3_ARCHIVE_VERSION=@@T3_ARCHIVE_VERSION@@
if [ -z "$T3_ARCHIVE_VERSION" ]; then
  printf 'No t3 release version was provided for the remote runtime.\\n' >&2
  exit 1
fi
# Self-contained release archive: no Node, npm, or compiler on the remote.
# Unpacked into the pinned-runtime layout so \`t3 service install\` reuses it.
T3_RELEASE_BASE_URL=@@T3_RELEASE_BASE_URL@@
T3_RUNTIME_DIR="$HOME/.t3/runtime/versions/$T3_ARCHIVE_VERSION"
t3_runtime_ready() {
  [ -x "$T3_RUNTIME_DIR/t3" ] && [ "$(cat "$T3_RUNTIME_DIR/.install-complete" 2>/dev/null)" = "$T3_ARCHIVE_VERSION" ]
}
if ! t3_runtime_ready; then
  mkdir -p "$HOME/.t3/runtime/versions"
  T3_LOCK="$HOME/.t3/runtime/versions/.$T3_ARCHIVE_VERSION.install.lock"
  # uutils mkdir can report success on EEXIST, so use shell noclobber.
  # An empty lock gets a short grace period for its owner to publish a PID.
  T3_LOCK_WAITED=0
  T3_LOCK_UNOWNED=0
  while ! (set -C; printf '%s\\n' "$$" > "$T3_LOCK") 2>/dev/null; do
    T3_LOCK_OWNER="$(cat "$T3_LOCK" 2>/dev/null || true)"
    if [ -n "$T3_LOCK_OWNER" ]; then
      T3_LOCK_UNOWNED=0
      if ! kill -0 "$T3_LOCK_OWNER" 2>/dev/null; then
        rm -rf "$T3_LOCK"
        continue
      fi
    else
      T3_LOCK_UNOWNED=$((T3_LOCK_UNOWNED + 1))
      if [ "$T3_LOCK_UNOWNED" -ge 5 ]; then
        rm -rf "$T3_LOCK"
        continue
      fi
    fi
    if [ "$T3_LOCK_WAITED" -ge @@T3_ARCHIVE_LOCK_WAIT_SECONDS@@ ]; then
      printf 'Another t3 %s installation has held %s for too long.\\n' "$T3_ARCHIVE_VERSION" "$T3_LOCK" >&2
      exit 1
    fi
    sleep 1
    T3_LOCK_WAITED=$((T3_LOCK_WAITED + 1))
  done
  trap 'rm -rf "$T3_LOCK"' EXIT
fi
if ! t3_runtime_ready; then
  case "$(uname -s)" in
    Darwin) T3_PLATFORM="darwin" ;;
    Linux) T3_PLATFORM="linux" ;;
    *) printf 'Remote host %s has no t3 release archive.\\n' "$(uname -s)" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) T3_ARCH="arm64" ;;
    x86_64 | amd64) T3_ARCH="x64" ;;
    *) printf 'Remote host %s has no t3 release archive.\\n' "$(uname -m)" >&2; exit 1 ;;
  esac
  T3_ARCHIVE="t3-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz"
  T3_STAGING="$(mktemp -d "$HOME/.t3/runtime/versions/.staging-XXXXXX")"
  trap 'rm -rf "$T3_STAGING" "$T3_LOCK"' EXIT
  t3_fetch() {
    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time "$3" "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 "$1" -O "$2"
    else printf 'Remote host needs curl or wget to download %s.\\n' "$T3_ARCHIVE" >&2; exit 1
    fi
  }
  t3_fetch "$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/SHA256SUMS" "$T3_STAGING/SHA256SUMS" @@T3_ARCHIVE_CHECKSUMS_SECONDS@@
  t3_fetch "$T3_RELEASE_BASE_URL/v$T3_ARCHIVE_VERSION/$T3_ARCHIVE" "$T3_STAGING/$T3_ARCHIVE" @@T3_ARCHIVE_DOWNLOAD_SECONDS@@
  T3_EXPECTED="$(grep " \\*\\{0,1\\}$T3_ARCHIVE$" "$T3_STAGING/SHA256SUMS" | cut -d' ' -f1)"
  if command -v sha256sum >/dev/null 2>&1; then
    T3_ACTUAL="$(sha256sum "$T3_STAGING/$T3_ARCHIVE" | cut -d' ' -f1)"
  else
    T3_ACTUAL="$(shasum -a 256 "$T3_STAGING/$T3_ARCHIVE" | cut -d' ' -f1)"
  fi
  if [ -z "$T3_EXPECTED" ] || [ "$T3_ACTUAL" != "$T3_EXPECTED" ]; then
    printf 'Checksum mismatch for %s.\\n' "$T3_ARCHIVE" >&2; exit 1
  fi
  tar -xzf "$T3_STAGING/$T3_ARCHIVE" -C "$T3_STAGING" --strip-components=1
  rm -f "$T3_STAGING/$T3_ARCHIVE" "$T3_STAGING/SHA256SUMS"
  # Prove the binary runs here (libc, arch) before marking it ready, or every
  # later launch would exec a broken install instead of retrying.
  if ! "$T3_STAGING/t3" --version >/dev/null 2>&1; then
    printf 'The t3 %s executable does not run on this host.\\n' "$T3_ARCHIVE_VERSION" >&2; exit 1
  fi
  printf '%s\\n' "$T3_ARCHIVE_VERSION" > "$T3_STAGING/.install-complete"
  rm -rf "$T3_RUNTIME_DIR"
  mv "$T3_STAGING" "$T3_RUNTIME_DIR"
fi
if [ -n "\${T3_LOCK:-}" ]; then
  rm -rf "$T3_LOCK"
  trap - EXIT
fi
exec "$T3_RUNTIME_DIR/t3" "$@"
`;
