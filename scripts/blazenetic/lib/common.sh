# shellcheck shell=bash
# t3b common library — sourced by the t3b* wrapper scripts.
#
# This file is meant to be *sourced*, never executed directly. It deliberately
# does NOT enable `set -Eeuo pipefail`; the executable wrappers do that. Keeping
# strict mode out of the library makes it safe to source from any context.
#
# All public functions are namespaced `t3b::`. Configuration is read from
# environment variables (optionally provided via an env file, see t3b::load_env):
#   T3B_REPO    - path to the live T3 Code working tree (default: $HOME/Code/t3code)
#   T3B_BRANCH  - long-lived downstream branch            (default: blazenetic)
#   T3B_TERMINAL, T3B_DEV_MODE - consumed by launchers / desktop entry

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

# Enable colour only on a TTY and when NO_COLOR is unset.
if [[ -t 2 && -z "${NO_COLOR:-}" ]]; then
  T3B_C_RESET=$'\033[0m'
  T3B_C_RED=$'\033[0;31m'
  T3B_C_GREEN=$'\033[0;32m'
  T3B_C_YELLOW=$'\033[0;33m'
  T3B_C_BLUE=$'\033[0;34m'
  T3B_C_BOLD=$'\033[1m'
else
  T3B_C_RESET='' T3B_C_RED='' T3B_C_GREEN='' T3B_C_YELLOW='' T3B_C_BLUE='' T3B_C_BOLD=''
fi

t3b::info() { printf '%s[t3b]%s %s\n' "$T3B_C_BLUE" "$T3B_C_RESET" "$*" >&2; }
t3b::warn() { printf '%s[t3b] warning:%s %s\n' "$T3B_C_YELLOW" "$T3B_C_RESET" "$*" >&2; }
t3b::err()  { printf '%s[t3b] error:%s %s\n' "$T3B_C_RED" "$T3B_C_RESET" "$*" >&2; }

# t3b::die <msg...> — print an error and exit non-zero.
t3b::die() { t3b::err "$@"; exit 1; }

# Status-labelled report lines (used by t3b-doctor).
t3b::status() {
  # usage: t3b::status <OK|WARN|FAIL|INFO> <message...>
  local label=$1; shift
  local colour=""
  case "$label" in
    OK)   colour=$T3B_C_GREEN ;;
    WARN) colour=$T3B_C_YELLOW ;;
    FAIL) colour=$T3B_C_RED ;;
    INFO) colour=$T3B_C_BLUE ;;
    *)    colour=$T3B_C_RESET ;;
  esac
  printf '  %s%-4s%s %s\n' "$colour" "$label" "$T3B_C_RESET" "$*"
}

# t3b::heading <text> — a section heading for reports.
t3b::heading() { printf '\n%s%s%s\n' "$T3B_C_BOLD" "$*" "$T3B_C_RESET"; }

# ---------------------------------------------------------------------------
# Environment / dependency helpers
# ---------------------------------------------------------------------------

# t3b::have <cmd> — true if a command exists on PATH.
t3b::have() { command -v "$1" >/dev/null 2>&1; }

# t3b::load_env — source optional wrapper env files if present. Only these two
# well-known locations are considered; arbitrary files are never sourced.
t3b::load_env() {
  local f
  for f in "$HOME/.config/t3code-blazenetic/env" "${T3B_REPO:-$HOME/Code/t3code}/.env.blazenetic"; do
    if [[ -f "$f" ]]; then
      # shellcheck disable=SC1090  # path is a fixed, known location
      source "$f"
    fi
  done
}

# t3b::ensure_vp — make the `vp` (Vite+) binary callable. Never installs it.
# If `vp` is not already on PATH, prepend the standard Vite+ bin dir. If it is
# still missing, die with the exact install hint.
t3b::ensure_vp() {
  if t3b::have vp; then return 0; fi
  local vpbin="$HOME/.vite-plus/bin"
  if [[ -x "$vpbin/vp" ]]; then
    PATH="$vpbin:$PATH"
    export PATH
  fi
  if ! t3b::have vp; then
    t3b::err "Vite+ (vp) is not installed — it is the mandated task runner for T3 Code."
    t3b::err "Install it with:"
    t3b::err "    curl -fsSL https://vite.plus | bash"
    t3b::err "then restart your shell (or add ~/.vite-plus/bin to PATH)."
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Repository helpers
# ---------------------------------------------------------------------------

# t3b::repo — resolve and echo the absolute repository path, or die.
t3b::repo() {
  local repo="${T3B_REPO:-$HOME/Code/t3code}"
  if [[ ! -d "$repo" ]]; then
    t3b::err "Repository not found at: $repo"
    t3b::err "Set T3B_REPO to your clone, or clone the fork:"
    t3b::err "    git clone https://github.com/Blazenetic/t3code \"$repo\""
    return 1
  fi
  if ! git -C "$repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    t3b::die "Path is not a git working tree: $repo"
  fi
  # Echo the canonical top-level path.
  git -C "$repo" rev-parse --show-toplevel
}

# t3b::default_branch — echo the configured downstream branch name.
t3b::default_branch() { printf '%s\n' "${T3B_BRANCH:-blazenetic}"; }

# t3b::branch <repo> — echo the currently checked-out branch (or a detached ref).
t3b::branch() { git -C "$1" rev-parse --abbrev-ref HEAD 2>/dev/null; }

# t3b::require_clean <repo> — die if the working tree has changes.
t3b::require_clean() {
  local repo=$1
  if [[ -n "$(git -C "$repo" status --porcelain)" ]]; then
    t3b::err "Working tree is not clean: $repo"
    t3b::err "Commit or stash your changes first. See:  git -C \"$repo\" status"
    return 1
  fi
  return 0
}

# t3b::require_deps <repo> — warn (do NOT install) if node_modules is absent.
t3b::require_deps() {
  local repo=$1
  if [[ ! -d "$repo/node_modules" ]]; then
    t3b::warn "Dependencies are not installed (no node_modules)."
    t3b::warn "Install them with:  (cd \"$repo\" && vp i)"
    return 1
  fi
  return 0
}

# t3b::ahead_behind <repo> <a> <b> — echo "<ahead> <behind>" of ref a relative
# to ref b (ahead = commits in a not in b). Empty if a ref is missing.
t3b::ahead_behind() {
  local repo=$1 a=$2 b=$3
  git -C "$repo" rev-parse --verify --quiet "$a" >/dev/null || return 1
  git -C "$repo" rev-parse --verify --quiet "$b" >/dev/null || return 1
  local ahead behind
  ahead=$(git -C "$repo" rev-list --count "$b..$a")
  behind=$(git -C "$repo" rev-list --count "$a..$b")
  printf '%s %s\n' "$ahead" "$behind"
}

# ---------------------------------------------------------------------------
# Session helpers
# ---------------------------------------------------------------------------

# t3b::session_type — echo wayland | x11 | unknown.
t3b::session_type() {
  if [[ -n "${WAYLAND_DISPLAY:-}" || "${XDG_SESSION_TYPE:-}" == "wayland" ]]; then
    printf 'wayland\n'
  elif [[ -n "${DISPLAY:-}" || "${XDG_SESSION_TYPE:-}" == "x11" ]]; then
    printf 'x11\n'
  else
    printf 'unknown\n'
  fi
}

# t3b::is_interactive — true if stdout is a terminal.
t3b::is_interactive() { [[ -t 1 ]]; }

# ---------------------------------------------------------------------------
# Process-tree teardown
# ---------------------------------------------------------------------------

# t3b::descendants <pid> — echo all descendant PIDs recursively (deepest first).
# Follows the parent chain, so children that put themselves in their own
# session/process group are still captured as long as the tree is intact at
# call time.
t3b::descendants() {
  local p=$1 k
  for k in $(pgrep -P "$p" 2>/dev/null || true); do
    t3b::descendants "$k"
    printf '%s\n' "$k"
  done
}

# t3b::kill_tree <pid> — terminate a process and its whole subtree.
# Snapshots descendants first (so escaped sessions are still reachable), sends
# SIGTERM leaves-first, waits briefly, then SIGKILLs any survivors. Also signals
# the root's process group to catch same-group children.
t3b::kill_tree() {
  local root=$1 p n=0
  [[ -n "$root" ]] || return 0
  local kids
  kids="$(t3b::descendants "$root")"
  for p in $kids "$root"; do kill -TERM "$p" 2>/dev/null || true; done
  kill -TERM -"$root" 2>/dev/null || true
  while kill -0 "$root" 2>/dev/null && (( n < 30 )); do sleep 0.1; ((n++)); done
  for p in $kids "$root"; do kill -KILL "$p" 2>/dev/null || true; done
  kill -KILL -"$root" 2>/dev/null || true
}
