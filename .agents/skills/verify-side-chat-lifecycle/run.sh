#!/usr/bin/env bash
# Model-checks SideChatLifecycle.tla with TLC. `run.sh` checks the default scope;
# `run.sh --external-sends` adds messages that are not the user's own (see SKILL.md).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
jar="$HOME/.local/share/tla/tla2tools-1.7.4.jar"
sha=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
if [ ! -f "$jar" ]; then
  mkdir -p "$(dirname "$jar")"
  curl -fsSL -o "$jar.tmp" https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar
  mv "$jar.tmp" "$jar"
fi
echo "$sha  $jar" | sha256sum -c --quiet
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$here/SideChatLifecycle.tla" "$here/SideChatLifecycle.cfg" "$work/"
[ "${1:-}" = "--external-sends" ] && sed -i 's/ExternalSends = FALSE/ExternalSends = TRUE/' "$work/SideChatLifecycle.cfg"
cd "$work"
exec systemd-run --user --scope -q -p MemoryMax=2G -p MemorySwapMax=0 -- \
  java -Xmx1g -XX:+UseParallelGC -cp "$jar" tlc2.TLC -deadlock -workers 2 -cleanup \
  -config SideChatLifecycle.cfg SideChatLifecycle.tla
