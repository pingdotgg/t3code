#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# T3 Code — Interactive Install Script
# https://github.com/aaditagrawal/t3code
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/aaditagrawal/t3code/main/scripts/install.sh | bash
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Constants ─────────────────────────────────────────────────────────────────

REPO_URL="https://github.com/aaditagrawal/t3code.git"
REQUIRED_NODE_MAJOR=24
REQUIRED_BUN_MAJOR=1
REQUIRED_BUN_MINOR=3
REQUIRED_BUN_PATCH=9
DEFAULT_INSTALL_DIR="./t3code"

# ── Colors & Symbols ─────────────────────────────────────────────────────────

if [[ -t 1 ]] && command -v tput &>/dev/null && [[ $(tput colors 2>/dev/null || echo 0) -ge 8 ]]; then
  RED=$(tput setaf 1)
  GREEN=$(tput setaf 2)
  YELLOW=$(tput setaf 3)
  CYAN=$(tput setaf 6)
  BOLD=$(tput bold)
  RESET=$(tput sgr0)
else
  RED="" GREEN="" YELLOW="" CYAN="" BOLD="" RESET=""
fi

OK="${GREEN}✓${RESET}"
FAIL="${RED}✗${RESET}"
WARN="${YELLOW}⚠${RESET}"
INFO="${CYAN}→${RESET}"

# ── Helpers ───────────────────────────────────────────────────────────────────

log_ok()   { printf "  %s %s\n" "$OK"   "$*"; }
log_fail() { printf "  %s %s\n" "$FAIL" "$*"; }
log_warn() { printf "  %s %s\n" "$WARN" "$*"; }
log_info() { printf "  %s %s\n" "$INFO" "$*"; }

die() {
  printf "\n%s%s%s\n" "$RED" "$*" "$RESET" >&2
  exit 1
}

# Detect whether stdin is interactive (not piped)
INTERACTIVE=true
if [[ ! -t 0 ]]; then
  INTERACTIVE=false
fi

# Prompt helper — reads from /dev/tty when stdin is piped, falls back to default
prompt() {
  local var_name="$1" message="$2" default="$3"
  if $INTERACTIVE; then
    read -rp "  ${CYAN}?${RESET} ${message} [${BOLD}${default}${RESET}]: " input
    printf -v "$var_name" '%s' "${input:-$default}"
  elif [[ -r /dev/tty ]]; then
    printf "  %s?%s %s [%s%s%s]: " "$CYAN" "$RESET" "$message" "$BOLD" "$default" "$RESET" > /dev/tty
    local answer
    read -r answer < /dev/tty
    printf -v "$var_name" '%s' "${answer:-$default}"
  else
    printf -v "$var_name" '%s' "$default"
  fi
}

prompt_choice() {
  local var_name="$1" message="$2" default="$3"
  shift 3
  local options=("$@")
  if $INTERACTIVE || [[ -r /dev/tty ]]; then
    local tty_out="/dev/tty"
    local tty_in="/dev/tty"
    if $INTERACTIVE; then
      tty_out="/dev/stderr"
      tty_in="/dev/stdin"
    fi
    printf "\n  %s?%s %s\n" "$CYAN" "$RESET" "$message" > "$tty_out"
    for i in "${!options[@]}"; do
      local num=$((i + 1))
      if [[ "$num" == "$default" ]]; then
        printf "    %s[%d] %s (default)%s\n" "$BOLD" "$num" "${options[$i]}" "$RESET" > "$tty_out"
      else
        printf "    [%d] %s\n" "$num" "${options[$i]}" > "$tty_out"
      fi
    done
    printf "  %s→%s Enter choice: " "$CYAN" "$RESET" > "$tty_out"
    local input
    read -r input < "$tty_in"
    input="${input:-$default}"
    # Validate
    if [[ ! "$input" =~ ^[0-9]+$ ]] || (( input < 1 || input > ${#options[@]} )); then
      log_warn "Invalid choice '${input}', using default: ${default}"
      input="$default"
    fi
    printf -v "$var_name" '%s' "$input"
  else
    printf -v "$var_name" '%s' "$default"
  fi
}

# ── Ctrl+C handler ───────────────────────────────────────────────────────────

cleanup() {
  printf "\n\n${YELLOW}Installation cancelled.${RESET}\n"
  exit 130
}
trap cleanup INT TERM

# ── Banner ────────────────────────────────────────────────────────────────────

banner() {
  printf "\n"
  printf "  ${BOLD}${CYAN}╔══════════════════════════════════════╗${RESET}\n"
  printf "  ${BOLD}${CYAN}║         T3 Code  —  Installer       ║${RESET}\n"
  printf "  ${BOLD}${CYAN}╚══════════════════════════════════════╝${RESET}\n"
  printf "\n"
}

# ── OS Detection ──────────────────────────────────────────────────────────────

detect_os() {
  OS_RAW="$(uname -s 2>/dev/null || echo unknown)"
  ARCH="$(uname -m 2>/dev/null || echo unknown)"

  case "$OS_RAW" in
    Darwin*)          OS="macos"   ;;
    Linux*)           OS="linux"   ;;
    CYGWIN*|MSYS*|MINGW*) OS="windows" ;;
    *)                OS="unknown" ;;
  esac

  # Detect Linux distro family
  DISTRO=""
  if [[ "$OS" == "linux" ]]; then
    if [[ -f /etc/os-release ]]; then
      # shellcheck disable=SC1091
      source /etc/os-release 2>/dev/null || true
      case "${ID:-}${ID_LIKE:-}" in
        *debian*|*ubuntu*) DISTRO="debian" ;;
        *fedora*|*rhel*|*centos*) DISTRO="fedora" ;;
        *arch*)            DISTRO="arch" ;;
        *)                 DISTRO="other" ;;
      esac
    fi
  fi

  # Detect WSL
  IS_WSL=false
  if [[ "$OS" == "linux" ]] && grep -qi microsoft /proc/version 2>/dev/null; then
    IS_WSL=true
  fi

  log_ok "Detected OS: ${BOLD}${OS}${RESET} (${ARCH})"
  [[ -n "$DISTRO" ]]  && log_info "Linux distro family: ${BOLD}${DISTRO}${RESET}"
  $IS_WSL             && log_info "Running inside ${BOLD}WSL${RESET}"
}

# ── Resolve a binary from multiple candidate paths ───────────────────────────

find_bin() {
  local name="$1"
  shift
  # First check PATH
  local found
  found="$(command -v "$name" 2>/dev/null || true)"
  if [[ -n "$found" ]]; then
    echo "$found"
    return 0
  fi
  # Then check explicit candidate paths
  for candidate in "$@"; do
    # Expand globs (e.g. nvm version dirs), preserving paths with spaces
    if [[ "$candidate" == *[\*\?\[]* ]]; then
      while IFS= read -r expanded; do
        if [[ -x "$expanded" ]]; then
          echo "$expanded"
          return 0
        fi
      done < <(compgen -G "$candidate")
    elif [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

# ── Prerequisite: git ─────────────────────────────────────────────────────────

check_git() {
  local git_bin
  git_bin="$(find_bin git \
    /usr/bin/git \
    /usr/local/bin/git \
    "$HOME/.local/bin/git" \
    "/c/Program Files/Git/bin/git.exe" \
    "/c/Program Files/Git/cmd/git.exe" \
  )" || true

  if [[ -n "$git_bin" ]]; then
    local ver
    ver="$("$git_bin" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -1)"
    log_ok "git found: ${BOLD}${git_bin}${RESET} (${ver})"
    GIT_BIN="$git_bin"
    return 0
  fi

  log_fail "git is ${BOLD}not installed${RESET}"
  suggest_install_git
  return 1
}

suggest_install_git() {
  printf "\n"
  log_info "Install git:"
  case "$OS" in
    macos)
      log_info "  brew install git"
      log_info "  — or — xcode-select --install"
      ;;
    linux)
      case "$DISTRO" in
        debian) log_info "  sudo apt update && sudo apt install -y git" ;;
        fedora) log_info "  sudo dnf install -y git" ;;
        arch)   log_info "  sudo pacman -S --noconfirm git" ;;
        *)      log_info "  Use your distro's package manager to install git" ;;
      esac
      ;;
    windows)
      log_info "  winget install --id Git.Git -e"
      log_info "  — or — https://git-scm.com/download/win"
      ;;
  esac
}

# ── Prerequisite: Node.js ────────────────────────────────────────────────────

check_node() {
  local node_bin
  node_bin="$(find_bin node \
    /usr/local/bin/node \
    /usr/bin/node \
    "$HOME/.local/bin/node" \
    "$HOME/.nvm/versions/node/"*/bin/node \
    "$HOME/.fnm/node-versions/"*/installation/bin/node \
    "$HOME/.volta/bin/node" \
    /opt/homebrew/bin/node \
  )" || true

  if [[ -z "$node_bin" ]]; then
    log_fail "Node.js is ${BOLD}not installed${RESET} (required >= ${REQUIRED_NODE_MAJOR})"
    suggest_install_node
    return 1
  fi

  local node_ver
  node_ver="$("$node_bin" --version 2>/dev/null)" || true
  local major
  major="$(echo "$node_ver" | sed 's/^v//' | cut -d. -f1)"

  if [[ -z "$major" ]] || (( major < REQUIRED_NODE_MAJOR )); then
    log_fail "Node.js ${BOLD}${node_ver}${RESET} found, but >= ${REQUIRED_NODE_MAJOR} is required"
    suggest_install_node
    return 1
  fi

  log_ok "Node.js found: ${BOLD}${node_bin}${RESET} (${node_ver})"
  return 0
}

suggest_install_node() {
  printf "\n"
  log_info "Install Node.js >= ${REQUIRED_NODE_MAJOR}:"
  case "$OS" in
    macos)
      log_info "  brew install node@${REQUIRED_NODE_MAJOR}"
      log_info "  — or — curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash"
      log_info "         nvm install ${REQUIRED_NODE_MAJOR}"
      ;;
    linux)
      log_info "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash"
      log_info "  nvm install ${REQUIRED_NODE_MAJOR}"
      case "$DISTRO" in
        debian) log_info "  — or — https://github.com/nodesource/distributions#installation-instructions" ;;
        fedora) log_info "  — or — https://github.com/nodesource/distributions#installation-instructions" ;;
        arch)   log_info "  — or — sudo pacman -S nodejs" ;;
      esac
      ;;
    windows)
      log_info "  winget install --id OpenJS.NodeJS -e"
      log_info "  — or — https://nodejs.org/en/download"
      ;;
  esac
}

# ── Prerequisite: bun ────────────────────────────────────────────────────────

# Compare two semver strings: returns 0 if $1 >= $2
semver_gte() {
  local a_major a_minor a_patch b_major b_minor b_patch
  IFS='.' read -r a_major a_minor a_patch <<< "$1"
  IFS='.' read -r b_major b_minor b_patch <<< "$2"
  a_major="${a_major:-0}"; a_minor="${a_minor:-0}"; a_patch="${a_patch:-0}"
  b_major="${b_major:-0}"; b_minor="${b_minor:-0}"; b_patch="${b_patch:-0}"

  (( a_major > b_major )) && return 0
  (( a_major < b_major )) && return 1
  (( a_minor > b_minor )) && return 0
  (( a_minor < b_minor )) && return 1
  (( a_patch >= b_patch )) && return 0
  return 1
}

check_bun() {
  local bun_bin
  bun_bin="$(find_bin bun \
    "$HOME/.bun/bin/bun" \
    /usr/local/bin/bun \
    /opt/homebrew/bin/bun \
  )" || true

  local required_ver="${REQUIRED_BUN_MAJOR}.${REQUIRED_BUN_MINOR}.${REQUIRED_BUN_PATCH}"

  if [[ -n "$bun_bin" ]]; then
    local bun_ver
    bun_ver="$("$bun_bin" --version 2>/dev/null)" || true
    bun_ver="${bun_ver#v}"  # strip leading v if present

    if semver_gte "$bun_ver" "$required_ver"; then
      log_ok "bun found: ${BOLD}${bun_bin}${RESET} (${bun_ver})"
      BUN_BIN="$bun_bin"
      return 0
    else
      log_warn "bun ${BOLD}${bun_ver}${RESET} found, but >= ${required_ver} is required"
    fi
  else
    log_warn "bun is ${BOLD}not installed${RESET} (required >= ${required_ver})"
  fi

  # Offer to auto-install bun
  install_bun
}

install_bun() {
  local required_ver="${REQUIRED_BUN_MAJOR}.${REQUIRED_BUN_MINOR}.${REQUIRED_BUN_PATCH}"
  printf "\n"
  log_info "bun >= ${required_ver} is ${BOLD}required${RESET} as the project package manager."

  local do_install="y"
  if $INTERACTIVE; then
    read -rp "  ${CYAN}?${RESET} Install bun now? [Y/n]: " do_install
    do_install="${do_install:-y}"
  elif [[ -r /dev/tty ]]; then
    printf "  %s?%s Install bun now? [Y/n]: " "$CYAN" "$RESET" > /dev/tty
    read -r do_install < /dev/tty
    do_install="${do_install:-y}"
  fi

  case "$do_install" in
    [Yy]|[Yy]es|"")
      log_info "Installing bun…"
      if [[ "$OS" == "windows" ]] && command -v powershell.exe &>/dev/null; then
        powershell.exe -Command "irm bun.sh/install.ps1 | iex" || die "Failed to install bun via PowerShell"
      else
        curl -fsSL https://bun.sh/install | bash || die "Failed to install bun"
      fi

      # Source the bun env so it's available in this session
      if [[ -f "$HOME/.bun/bin/bun" ]]; then
        export PATH="$HOME/.bun/bin:$PATH"
        BUN_BIN="$HOME/.bun/bin/bun"
      else
        BUN_BIN="$(command -v bun 2>/dev/null || true)"
      fi

      if [[ -z "$BUN_BIN" ]] || ! "$BUN_BIN" --version &>/dev/null; then
        die "bun installation succeeded but binary not found. Restart your shell and try again."
      fi

      local installed_ver
      installed_ver="$("$BUN_BIN" --version 2>/dev/null)"
      installed_ver="${installed_ver#v}"
      log_ok "bun installed: ${BOLD}${BUN_BIN}${RESET} (${installed_ver})"
      ;;
    *)
      die "bun is required. Install it manually: https://bun.sh"
      ;;
  esac
}

# ── Prerequisites Summary ────────────────────────────────────────────────────

check_prerequisites() {
  printf "\n  ${BOLD}Checking prerequisites…${RESET}\n\n"

  local failed=false

  GIT_BIN="" BUN_BIN=""

  check_git  || failed=true
  check_node || failed=true

  if $failed; then
    printf "\n"
    die "Please install the missing prerequisites above, then re-run this script."
  fi

  # bun check handles its own installation flow
  check_bun

  if [[ -z "$BUN_BIN" ]]; then
    die "bun is required but could not be found after installation."
  fi

  printf "\n  ${GREEN}${BOLD}All prerequisites satisfied.${RESET}\n"
}

# ── Step 1: Clone ────────────────────────────────────────────────────────────

step_clone() {
  printf "\n  ${BOLD}Step 1: Clone Repository${RESET}\n\n"

  local install_dir
  prompt install_dir "Install directory" "$DEFAULT_INSTALL_DIR"

  # Expand ~ if present
  install_dir="${install_dir/#\~/$HOME}"

  if [[ -d "$install_dir" ]]; then
    if [[ -d "$install_dir/.git" ]]; then
      log_warn "Directory '${install_dir}' already exists and is a git repo."
      log_info "Pulling latest changes…"
      "$GIT_BIN" -C "$install_dir" pull --ff-only || log_warn "Pull failed — continuing with existing checkout"
    else
      die "Directory '${install_dir}' already exists but is not a git repo. Remove it or choose another path."
    fi
  else
    log_info "Cloning ${REPO_URL} → ${install_dir}"
    "$GIT_BIN" clone "$REPO_URL" "$install_dir" || die "git clone failed"
    log_ok "Repository cloned"
  fi

  INSTALL_DIR="$(cd "$install_dir" && pwd)"
}

# ── Step 2: Build Mode ──────────────────────────────────────────────────────

step_build_mode() {
  prompt_choice BUILD_MODE "Choose build mode:" "1" \
    "Development (hot-reload)" \
    "Production (full build)"
}

# ── Step 3: App Type ─────────────────────────────────────────────────────────

step_app_type() {
  prompt_choice APP_TYPE "Choose app type:" "1" \
    "Desktop app (Electron)" \
    "Web app (browser)"
}

# ── Step 4: Install Dependencies ─────────────────────────────────────────────

step_install_deps() {
  printf "\n  ${BOLD}Step 4: Install Dependencies${RESET}\n\n"

  log_info "Running ${BOLD}bun install${RESET} in ${INSTALL_DIR}…"
  (cd "$INSTALL_DIR" && "$BUN_BIN" install) || die "bun install failed"
  log_ok "Dependencies installed"
}

# ── Step 5: Run ──────────────────────────────────────────────────────────────

step_run() {
  printf "\n  ${BOLD}Step 5: Launch T3 Code${RESET}\n\n"

  local cmd=""
  local label=""

  if [[ "$BUILD_MODE" == "1" && "$APP_TYPE" == "1" ]]; then
    cmd="dev:desktop"
    label="Development · Desktop"
  elif [[ "$BUILD_MODE" == "1" && "$APP_TYPE" == "2" ]]; then
    cmd="dev"
    label="Development · Web"
  elif [[ "$BUILD_MODE" == "2" && "$APP_TYPE" == "1" ]]; then
    label="Production · Desktop"
  elif [[ "$BUILD_MODE" == "2" && "$APP_TYPE" == "2" ]]; then
    label="Production · Web"
  fi

  log_info "Mode: ${BOLD}${label}${RESET}"

  if [[ "$BUILD_MODE" == "2" ]]; then
    # Production: build first, then start
    local build_cmd start_cmd
    if [[ "$APP_TYPE" == "1" ]]; then
      build_cmd="build:desktop"
      start_cmd="start:desktop"
    else
      build_cmd="build"
      start_cmd="start"
    fi

    log_info "Building… (${BOLD}bun run ${build_cmd}${RESET})"
    (cd "$INSTALL_DIR" && "$BUN_BIN" run "$build_cmd") || die "Build failed"
    log_ok "Build complete"

    log_info "Starting… (${BOLD}bun run ${start_cmd}${RESET})"
    (cd "$INSTALL_DIR" && exec "$BUN_BIN" run "$start_cmd")
  else
    # Development: single command
    log_info "Starting… (${BOLD}bun run ${cmd}${RESET})"
    (cd "$INSTALL_DIR" && exec "$BUN_BIN" run "$cmd")
  fi
}

# ── Non-interactive Warning ──────────────────────────────────────────────────

warn_non_interactive() {
  if ! $INTERACTIVE; then
    printf "\n"
    log_warn "${BOLD}Non-interactive mode detected${RESET} (piped input)."
    log_warn "Using defaults: dir=${DEFAULT_INSTALL_DIR}, mode=Development, type=Desktop"
    printf "\n"
  fi
}

# ── Main ──────────────────────────────────────────────────────────────────────

main() {
  banner
  detect_os
  warn_non_interactive
  check_prerequisites

  step_clone
  step_build_mode
  step_app_type
  step_install_deps
  step_run
}

main "$@"
