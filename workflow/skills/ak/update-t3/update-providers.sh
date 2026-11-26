#!/usr/bin/env bash
# Updates the provider CLIs installed on this machine. Mise-managed tools go through
# `mise upgrade`; the rest use their own updater. Prints one "provider: version" line each.
set -uo pipefail
# Same order as the t3code service, so this updates the copy T3 runs.
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"

mise_tools=()
if command -v mise >/dev/null; then
  while read -r tool _; do
    case "$tool" in
      claude | codex | opencode | cursor-agent | gemini | pi | copilot | npm:@xai-official/grok | http:muse) mise_tools+=("$tool") ;;
    esac
  done < <(mise ls --current 2>/dev/null)
  if [ ${#mise_tools[@]} -gt 0 ]; then
    echo "mise upgrade ${mise_tools[*]}"
    MISE_MINIMUM_RELEASE_AGE=0 mise upgrade "${mise_tools[@]}" || echo "FAILED: mise upgrade" >&2
  fi
fi

own_updater() {
  local cli="$1"
  shift
  command -v "$cli" >/dev/null || return 0
  [[ " ${mise_tools[*]} " == *" $cli "* ]] && return 0
  echo "$cli $*"
  "$cli" "$@" </dev/null || echo "FAILED: $cli $*" >&2
}
own_updater claude update
own_updater opencode upgrade
# The grok package only ships a launcher; the binary it runs updates itself, even under mise.
if command -v grok >/dev/null; then
  echo "grok update"
  grok update </dev/null || echo "FAILED: grok update" >&2
fi

for cli in claude codex grok opencode cursor-agent gemini pi copilot muse; do
  command -v "$cli" >/dev/null || continue
  echo "$cli: $(timeout 30 "$cli" --version </dev/null 2>&1 | head -1)"
done
