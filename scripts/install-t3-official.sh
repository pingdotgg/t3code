#!/usr/bin/env bash
#
# Download a signed upstream macOS release and install it as
# /Applications/T3 Code (Official).app without modifying its signed contents.
#
# Usage:
#   scripts/install-t3-official.sh                    # latest stable
#   scripts/install-t3-official.sh --channel nightly  # latest Nightly
#   scripts/install-t3-official.sh --no-launch        # skip launching
#
set -euo pipefail

APP_NAME="T3 Code (Official)"
INSTALL_DEST="/Applications/${APP_NAME}.app"
UPSTREAM_REPOSITORY="pingdotgg/t3code"
UPSTREAM_APP_ID="com.t3tools.t3code"
UPSTREAM_TEAM_ID="ARK85ZXQ4Z"
T3_HOME="${T3CODE_OFFICIAL_HOME:-${HOME}/.t3}"
STATE_DIR="${T3_HOME}/userdata"
STATE_DB="${STATE_DIR}/state.sqlite"
DESKTOP_SETTINGS_PATH="${STATE_DIR}/desktop-settings.json"
CHROMIUM_PROFILE="${HOME}/Library/Application Support/t3code"
UPDATER_CACHE="${HOME}/Library/Caches/t3code-updater"

DO_LAUNCH=1
CHANNEL="stable"
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --) ;;
    --channel)
      if [[ "$#" -lt 2 ]]; then
        echo "--channel requires stable or nightly." >&2
        exit 2
      fi
      CHANNEL="$2"
      shift
      ;;
    --no-launch) DO_LAUNCH=0 ;;
    -h|--help)
      sed -n '2,9p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
  shift
done

if [[ "$CHANNEL" != "stable" && "$CHANNEL" != "nightly" ]]; then
  echo "Unsupported channel: ${CHANNEL}. Expected stable or nightly." >&2
  exit 2
fi

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This script only runs on macOS." >&2
  exit 1
fi

case "$(uname -m)" in
  arm64) RELEASE_ARCH="arm64" ;;
  x86_64) RELEASE_ARCH="x64" ;;
  *)
    echo "Unsupported macOS architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is required." >&2
  exit 1
fi

log() { printf '\n[install-t3-official] %s\n' "$*"; }

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/t3code-official.XXXXXX")"
BACKUP_DIR="${HOME}/T3 Code Backups/official-update-$(date +%Y%m%d-%H%M%S)"
MOUNT_POINT=""
RESET_BROWSER_CREDENTIALS=0
cleanup() {
  if [[ -n "$MOUNT_POINT" && -d "$MOUNT_POINT" ]]; then
    hdiutil detach "$MOUNT_POINT" -quiet || hdiutil detach "$MOUNT_POINT" -force -quiet || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

if [[ "$CHANNEL" == "stable" ]]; then
  RELEASE_TAG="$(gh release view --repo "$UPSTREAM_REPOSITORY" --json tagName,isPrerelease \
    --jq 'select(.isPrerelease == false) | .tagName')"
else
  RELEASE_TAG="$(gh release list --repo "$UPSTREAM_REPOSITORY" --limit 100 \
    --json tagName,isPrerelease,publishedAt \
    --jq '[.[] | select(.isPrerelease == true and (.tagName | contains("-nightly.")))] | sort_by(.publishedAt) | last | .tagName')"
fi
if [[ -z "$RELEASE_TAG" ]]; then
  echo "Failed to resolve the latest ${CHANNEL} upstream release." >&2
  exit 1
fi

log "Downloading ${CHANNEL} ${RELEASE_TAG} (${RELEASE_ARCH}) from ${UPSTREAM_REPOSITORY}..."
gh release download \
  --repo "$UPSTREAM_REPOSITORY" \
  "$RELEASE_TAG" \
  --pattern "T3-Code-*-${RELEASE_ARCH}.dmg" \
  --dir "$WORK_DIR"

DMG_PATH="$(find "$WORK_DIR" -maxdepth 1 -type f -name '*.dmg' -print -quit)"
if [[ -z "$DMG_PATH" ]]; then
  echo "The upstream release did not contain a ${RELEASE_ARCH} DMG." >&2
  exit 1
fi

log "Mounting $(basename "$DMG_PATH")..."
ATTACH_OUTPUT="$(hdiutil attach -nobrowse -readonly -plist "$DMG_PATH")"
MOUNT_POINT="$(printf '%s' "$ATTACH_OUTPUT" \
  | /usr/bin/awk '/<string>\/Volumes\//{ sub(/.*<string>/,""); sub(/<\/string>.*/,""); print; exit }')"
if [[ -z "$MOUNT_POINT" || ! -d "$MOUNT_POINT" ]]; then
  echo "Failed to determine the DMG mount point." >&2
  exit 1
fi

SRC_APP="$(find "$MOUNT_POINT" -maxdepth 1 -type d -name 'T3 Code*.app' -print -quit)"
if [[ -z "$SRC_APP" ]]; then
  echo "The mounted DMG did not contain a T3 Code app." >&2
  exit 1
fi

codesign --verify --deep --strict "$SRC_APP"
SIGNING_DETAILS="$(codesign -dv --verbose=4 "$SRC_APP" 2>&1)"
SOURCE_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "${SRC_APP}/Contents/Info.plist")"
if [[ "$CHANNEL" == "stable" && "$SOURCE_VERSION" == *-nightly.* ]]; then
  echo "Refusing to install Nightly version ${SOURCE_VERSION} on the stable channel." >&2
  exit 1
fi
if [[ "$CHANNEL" == "nightly" && "$SOURCE_VERSION" != *-nightly.* ]]; then
  echo "Refusing to install stable version ${SOURCE_VERSION} on the Nightly channel." >&2
  exit 1
fi
if ! grep -Fq "Identifier=${UPSTREAM_APP_ID}" <<<"$SIGNING_DETAILS"; then
  echo "Refusing to install an app with an unexpected bundle identifier." >&2
  exit 1
fi
if ! grep -Fq "TeamIdentifier=${UPSTREAM_TEAM_ID}" <<<"$SIGNING_DETAILS"; then
  echo "Refusing to install an app not signed by the upstream T3 Tools team." >&2
  exit 1
fi

log "Quitting any running Official instance..."
osascript -e 'tell application "T3 Code (Alpha)" to quit' >/dev/null 2>&1 || true
osascript -e 'tell application "T3 Code (Nightly)" to quit' >/dev/null 2>&1 || true
for _ in {1..100}; do
  if ! pgrep -f "${INSTALL_DEST}/Contents/MacOS/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.05
done
if pgrep -f "${INSTALL_DEST}/Contents/MacOS/" >/dev/null 2>&1; then
  echo "${APP_NAME} did not quit; close it and retry." >&2
  exit 1
fi

if [[ -f "$STATE_DB" ]] && command -v sqlite3 >/dev/null 2>&1; then
  SESSION_TABLE_EXISTS="$(sqlite3 "$STATE_DB" \
    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'auth_sessions';")"
  PAIRING_TABLE_EXISTS="$(sqlite3 "$STATE_DB" \
    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'auth_pairing_links';")"
  SESSION_HAS_SCOPES="$(sqlite3 "$STATE_DB" \
    "SELECT COUNT(*) FROM pragma_table_info('auth_sessions') WHERE name = 'scopes';")"
  PAIRING_HAS_SCOPES="$(sqlite3 "$STATE_DB" \
    "SELECT COUNT(*) FROM pragma_table_info('auth_pairing_links') WHERE name = 'scopes';")"
  SESSION_HAS_ROLE="$(sqlite3 "$STATE_DB" \
    "SELECT COUNT(*) FROM pragma_table_info('auth_sessions') WHERE name = 'role';")"
  PAIRING_HAS_ROLE="$(sqlite3 "$STATE_DB" \
    "SELECT COUNT(*) FROM pragma_table_info('auth_pairing_links') WHERE name = 'role';")"
  if [[ "$SESSION_TABLE_EXISTS" == "1" && "$PAIRING_TABLE_EXISTS" == "1" ]] \
    && [[ "$SESSION_HAS_SCOPES" != "1" || "$PAIRING_HAS_SCOPES" != "1" \
      || "$SESSION_HAS_ROLE" == "1" || "$PAIRING_HAS_ROLE" == "1" ]]; then
    log "Repairing the Nightly auth migration mismatch..."
    mkdir -p "$BACKUP_DIR"
    sqlite3 "$STATE_DB" ".backup '${BACKUP_DIR}/state.sqlite'"
    RESET_BROWSER_CREDENTIALS=1
    sqlite3 "$STATE_DB" <<'SQL'
BEGIN IMMEDIATE;
DROP TABLE auth_sessions;
DROP TABLE auth_pairing_links;
CREATE TABLE auth_pairing_links (
  id TEXT PRIMARY KEY,
  credential TEXT NOT NULL UNIQUE,
  method TEXT NOT NULL,
  scopes TEXT NOT NULL,
  subject TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_auth_pairing_links_active
ON auth_pairing_links(revoked_at, consumed_at, expires_at);
CREATE TABLE auth_sessions (
  session_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  scopes TEXT NOT NULL,
  method TEXT NOT NULL,
  client_label TEXT,
  client_ip_address TEXT,
  client_user_agent TEXT,
  client_device_type TEXT NOT NULL DEFAULT 'unknown',
  client_os TEXT,
  client_browser TEXT,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_connected_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_auth_sessions_active
ON auth_sessions(revoked_at, expires_at, issued_at);
COMMIT;
SQL
  fi
fi

if [[ "$RESET_BROWSER_CREDENTIALS" == "1" && -d "$CHROMIUM_PROFILE" ]]; then
  log "Resetting Official browser credentials..."
  mkdir -p "$BACKUP_DIR"
  mv "$CHROMIUM_PROFILE" "${BACKUP_DIR}/t3code-profile"
fi

mkdir -p "$STATE_DIR"
if [[ -f "$DESKTOP_SETTINGS_PATH" ]]; then
  SETTINGS_DOCUMENT="$(node -e '
    const fs = require("node:fs");
    const path = process.argv[1];
    const value = JSON.parse(fs.readFileSync(path, "utf8"));
    value.updateChannel = process.argv[2];
    value.updateChannelConfiguredByUser = true;
    process.stdout.write(`${JSON.stringify(value)}\n`);
  ' "$DESKTOP_SETTINGS_PATH" "$([[ "$CHANNEL" == "nightly" ]] && echo nightly || echo latest)")"
else
  if [[ "$CHANNEL" == "nightly" ]]; then
    SETTINGS_DOCUMENT='{"updateChannel":"nightly","updateChannelConfiguredByUser":true}'
  else
    SETTINGS_DOCUMENT='{"updateChannel":"latest","updateChannelConfiguredByUser":true}'
  fi
fi
printf '%s\n' "$SETTINGS_DOCUMENT" >"$DESKTOP_SETTINGS_PATH"

log "Installing ${INSTALL_DEST}..."
rm -rf "$INSTALL_DEST"
ditto "$SRC_APP" "$INSTALL_DEST"
codesign --verify --deep --strict "$INSTALL_DEST"

if [[ -e "$UPDATER_CACHE" ]]; then
  chflags -R nouchg "$UPDATER_CACHE" 2>/dev/null || true
  chmod -R u+w "$UPDATER_CACHE" 2>/dev/null || true
  rm -rf "$UPDATER_CACHE"
fi
mkdir -p "$UPDATER_CACHE"

INSTALLED_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "${INSTALL_DEST}/Contents/Info.plist")"
log "Installed signed upstream T3 Code v${INSTALLED_VERSION} as ${APP_NAME}"
log "Configured Official for ${CHANNEL} updates."

if [[ "$DO_LAUNCH" -eq 1 ]]; then
  log "Launching..."
  open "$INSTALL_DEST"
fi

log "Done."
