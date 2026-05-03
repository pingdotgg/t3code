#!/usr/bin/env sh
set -eu

write_b64_file() {
  env_name="$1"
  target_path="$2"
  value="$(printenv "$env_name" || true)"
  if [ -z "$value" ]; then
    return 0
  fi

  mkdir -p "$(dirname "$target_path")"
  umask 077
  printf '%s' "$value" | base64 -d > "$target_path"
}

export HOME="${HOME:-/root}"
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export T3CODE_HOME="${T3CODE_HOME:-/var/lib/t3code}"
export T3_RUNTIME_WORKSPACE="${T3_RUNTIME_WORKSPACE:-/workspace/t3code}"
export T3_RUNTIME_PORT="${T3_RUNTIME_PORT:-8787}"

write_b64_file T3_CODEX_AUTH_JSON_B64 "$CODEX_HOME/auth.json"
write_b64_file T3_CODEX_CONFIG_TOML_B64 "$CODEX_HOME/config.toml"
write_b64_file T3_GH_HOSTS_YML_B64 "$XDG_CONFIG_HOME/gh/hosts.yml"

if [ -z "${OPENCODE_CONFIG_CONTENT:-}" ] && [ -n "${T3_OPENCODE_CONFIG_JSON_B64:-}" ]; then
  OPENCODE_CONFIG_CONTENT="$(printf '%s' "$T3_OPENCODE_CONFIG_JSON_B64" | base64 -d)"
  export OPENCODE_CONFIG_CONTENT
fi

if [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
  token="${GH_TOKEN:-$GITHUB_TOKEN}"
  export GH_TOKEN="$token"
  export GITHUB_TOKEN="${GITHUB_TOKEN:-$token}"
  mkdir -p "$HOME"
  umask 077
  printf 'https://x-access-token:%s@github.com\n' "$token" > "$HOME/.git-credentials"
  git config --global credential.helper store
fi

git config --global --add safe.directory "$T3_RUNTIME_WORKSPACE" || true

if [ -n "${T3_OPENCODE_MODEL:-}" ] && [ "${T3_DISABLE_RUNTIME_SETTINGS_BOOTSTRAP:-}" != "1" ]; then
  settings_path="$T3CODE_HOME/userdata/settings.json"
  if [ ! -f "$settings_path" ]; then
    mkdir -p "$(dirname "$settings_path")"
    cat > "$settings_path" <<EOF
{
  "textGenerationModelSelection": {
    "instanceId": "opencode",
    "model": "$T3_OPENCODE_MODEL"
  },
  "providers": {
    "codex": {
      "enabled": false
    },
    "claudeAgent": {
      "enabled": false
    },
    "cursor": {
      "enabled": false
    },
    "opencode": {
      "enabled": true,
      "binaryPath": "opencode",
      "customModels": ["$T3_OPENCODE_MODEL"]
    }
  }
}
EOF
  fi
fi

exec node /app/apps/server/dist/bin.mjs serve \
  --host 0.0.0.0 \
  --port "$T3_RUNTIME_PORT" \
  --base-dir "$T3CODE_HOME" \
  --no-browser \
  "$T3_RUNTIME_WORKSPACE"
