#!/usr/bin/env bash
set -euo pipefail

apk_name=t3code-android-beta-2.3.0-784.apk
apk_sha=f5060a87457eed6d3700f5018a1f0546da5027554ca2fd20b0ca87caca983abe
package=com.t3tools.t3code
port=13773

scratch="$(mktemp -d)"
server_pid=
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT

curl --fail --location --retry 3 \
  --output "$scratch/$apk_name" \
  "https://github.com/pingdotgg/t3code/releases/download/android-beta-784/$apk_name"
printf '%s  %s\n' "$apk_sha" "$scratch/$apk_name" | sha256sum --check
abi_list="$(adb shell getprop ro.product.cpu.abilist | tr -d '\r')"
if [[ ",$abi_list," != *,arm64-v8a,* && ",$abi_list," != *,armeabi-v7a,* ]]; then
  echo "The emulator image cannot run the ARM-only stock APK (ABIs: $abi_list)." >&2
  exit 1
fi
adb install "$scratch/$apk_name"

node apps/server/src/bin.ts serve --host 127.0.0.1 --port "$port" --base-dir "$scratch/host" > "$scratch/server.log" 2>&1 &
server_pid=$!
if ! curl --retry 45 --retry-all-errors --retry-delay 1 --max-time 2 --fail --silent \
  "http://127.0.0.1:$port/.well-known/t3/environment" >/dev/null; then
  echo "Continuum did not start its isolated backend." >&2
  exit 1
fi

pairing_output="$(T3CODE_PORT="$port" node apps/server/src/bin.ts auth pairing create \
  --base-dir "$scratch/host" --base-url "http://10.0.2.2:$port" --ttl 5m --label "Android beta 784" 2>&1)"
pairing_url="$(printf '%s\n' "$pairing_output" | sed -n 's/^Pair URL: //p' | tail -1)"
[[ -n "$pairing_url" ]] || { echo "Pairing URL unavailable." >&2; exit 1; }

deep_link="$(PAIRING_URL="$pairing_url" node --input-type=module - <<'NODE'
const params = new URLSearchParams({pairingUrl: process.env.PAIRING_URL, autoConnect: "1"});
process.stdout.write(`t3code://connections/new?${params}`);
NODE
)"
adb shell am start -W -a android.intent.action.VIEW -d "'$deep_link'" -p "$package" > "$scratch/launch.log" 2>&1
if grep -q '^Error:' "$scratch/launch.log"; then
  echo "Stock Android beta could not open its Add Environment route." >&2
  exit 1
fi

db="$scratch/host/userdata/statev2.sqlite"
for _ in $(seq 1 60); do
  # The isolated backend has no other client. WebSocket authentication records this timestamp.
  connected="$(sqlite3 -readonly "$db" 'SELECT count(*) FROM auth_sessions WHERE last_connected_at IS NOT NULL AND revoked_at IS NULL;' || true)"
  if [[ "$connected" == 1 ]]; then
    echo "Stock Android beta 2.3.0 (784) paired and authenticated a WebSocket with Continuum."
    adb shell dumpsys package "$package" | awk '/versionName=/ && !found++'
    exit 0
  fi
  sleep 2
done
echo "The APK opened, but Continuum recorded no authenticated client connection." >&2
exit 1
