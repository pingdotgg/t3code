#!/bin/sh
set -eu
cd "$(dirname "$0")"
for tool in bun pebble tailscale openssl launchctl lsof; do
  command -v "$tool" >/dev/null || { printf 'Install %s first.\n' "$tool" >&2; exit 1; }
done
: "${1:?Usage: ./install.sh <phone IP shown in Pebble Dev Connection>}"
phone=$1
label=codes.t3.pebble-companion
agent="$HOME/Library/LaunchAgents/$label.plist"
if [ -e "$agent" ] || launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
  printf 'The Pebble companion is already installed. Remove it before reinstalling.\n' >&2; exit 1
fi
if lsof -nP -iTCP:9383 -sTCP:LISTEN >/dev/null 2>&1; then
  printf 'Port 9383 is already in use. Stop the existing service before installing.\n' >&2; exit 1
fi
state_file="${T3CODE_HOME:-$HOME/.t3}/userdata/server-runtime.json"
[ -r "$state_file" ] || { printf 'Start T3 Code on this Mac first.\n' >&2; exit 1; }
status=$(tailscale status --json)
name=$(printf '%s' "$status" | bun -e 'const s = await Bun.stdin.text(); const x = JSON.parse(s); if (x.BackendState !== "Running" || !x.Self?.DNSName || !x.Self?.TailscaleIPs?.[0]) process.exit(1); console.log(x.Self.DNSName.replace(/\.$/, ""))') || { printf 'Connect this Mac to Tailscale first.\n' >&2; exit 1; }
ip=$(printf '%s' "$status" | bun -e 'const x = JSON.parse(await Bun.stdin.text()); console.log(x.Self.TailscaleIPs[0])')
mkdir -p .tls
chmod 700 .tls
umask 077
[ -s .pebble-token ] || openssl rand -hex 32 > .pebble-token
chmod 600 .pebble-token
tailscale cert --cert-file .tls/cert.pem --key-file .tls/key.pem "$name"
T3_PEBBLE_URL="https://$name:9383" T3_PEBBLE_TOKEN="$(cat .pebble-token)" bun configure-build.ts
pebble build
pebble install --phone "$phone"
T3_PEBBLE_INSTALL_DIR="$PWD" T3_PEBBLE_INSTALL_IP="$ip" T3_PEBBLE_INSTALL_DOMAIN="$name" T3_PEBBLE_INSTALL_STATE="$state_file" bun service/install.ts
printf '\nInstalled. Open T3 Code settings in the Pebble phone app to pair and set your ElevenLabs key.\n'
