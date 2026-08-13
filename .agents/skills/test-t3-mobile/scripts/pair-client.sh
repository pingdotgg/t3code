#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: $0 <ios|android> <device-id> <server-port> <base-dir> [url-scheme]" >&2
  exit 2
}

[[ $# -ge 4 && $# -le 5 ]] || usage

platform="$1"
device_id="$2"
server_port="$3"
base_dir="$4"
url_scheme="${5:-t3code-dev}"

case "$platform" in
  ios)
    mobile_origin="http://127.0.0.1:${server_port}"
    ;;
  android)
    mobile_origin="http://10.0.2.2:${server_port}"
    ;;
  *)
    usage
    ;;
esac

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if ! pairing_output="$({
  T3CODE_PORT="$server_port" node apps/server/src/bin.ts auth pairing create \
    --base-dir "$base_dir" \
    --base-url "$mobile_origin" \
    --ttl 15m \
    --label "agent-mobile-${device_id:0:8}"
} 2>&1)"; then
  echo "Could not mint a mobile pairing credential." >&2
  exit 1
fi

pairing_url="$(printf '%s\n' "$pairing_output" | sed -n 's/^Pair URL: //p' | tail -n 1)"
if [[ -z "$pairing_url" ]]; then
  echo "Could not parse the mobile pairing URL." >&2
  exit 1
fi

deep_link="$(PAIRING_URL="$pairing_url" URL_SCHEME="$url_scheme" node - <<'NODE'
const query = new URLSearchParams({
  pairingUrl: process.env.PAIRING_URL,
  autoConnect: "1",
});
process.stdout.write(`${process.env.URL_SCHEME}://connections/new?${query}`);
NODE
)"

case "$platform" in
  ios)
    xcrun simctl openurl "$device_id" "$deep_link"
    ;;
  android)
    # adb shell re-joins its arguments and evaluates them through the device
    # shell, so the deep link's `?`/`&` must be quoted once more for that shell.
    adb -s "$device_id" shell \
      "am start -W -a android.intent.action.VIEW -d '$deep_link' com.t3tools.t3code.dev" \
      >/dev/null
    ;;
esac

echo "Opened the existing Add Environment route with a fresh pairing credential."
