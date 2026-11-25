#!/usr/bin/env bash
# Makes this Mac the fork's macOS release runner (docs/operations/fork-desktop-build.md). It
# prepares a Tart VM once, then a LaunchAgent runs each job in a fresh clone of it, which it deletes
# afterwards, as GitHub's hosted runners do: the release workflows expect a clean machine. Run it
# again to repair or update the setup.
#
# Needs Homebrew, and gh signed in as an admin of the repository. The VMs keep Cirrus Labs' default
# `admin` password: Tart's network reaches them only from this Mac.
set -euo pipefail

repo="${1:-martinothamar/t3code}"
base=mac-runner
image=ghcr.io/cirruslabs/macos-tahoe-base:latest
label=fork-mac
support="$HOME/Library/Application Support/fork-mac-runner"
agent="$HOME/Library/LaunchAgents/local.fork-mac-runner.plist"

command -v brew >/dev/null || { echo "Install Homebrew first: https://brew.sh" >&2; exit 1; }
command -v tart >/dev/null || brew install openai/tools/tart
command -v sshpass >/dev/null || brew install cirruslabs/cli/sshpass
command -v gh >/dev/null || brew install gh
gh auth status >/dev/null 2>&1 || gh auth login

echo "Keeping this Mac awake, so the runner stays reachable (asks for your password)."
sudo pmset -a sleep 0

# Stop whatever an earlier setup left running.
for old in "$agent" "$HOME/Library/LaunchAgents/local.$base.plist"; do
  launchctl bootout "gui/$(id -u)" "$old" 2>/dev/null || true
done
rm -f "$HOME/Library/LaunchAgents/local.$base.plist"
tart list --source local | awk 'NR > 1 { print $2 }' | while read -r vm; do
  [[ "$vm" == "$base" || "$vm" == "$base"-* ]] || continue
  tart stop "$vm" >/dev/null 2>&1 || true
  [[ "$vm" == "$base" ]] || tart delete "$vm"
done
gh api "repos/$repo/actions/runners" --jq '.runners[] | select(.name | startswith("mac-runner")) | .id' |
  while read -r id; do gh api -X DELETE "repos/$repo/actions/runners/$id"; done

tart get "$base" >/dev/null 2>&1 || tart clone "$image" "$base"
cpus=$(( $(sysctl -n hw.ncpu) / 2 )); (( cpus >= 4 )) || cpus=4
memory_gb=$(( $(sysctl -n hw.memsize) / 1073741824 / 2 )); (( memory_gb <= 16 )) || memory_gb=16
tart set "$base" --cpu "$cpus" --memory $(( memory_gb * 1024 )) --disk-size 120

echo "Preparing $base..."
tart run --no-graphics "$base" >/dev/null 2>&1 &
pid=$!
ip="$(tart ip --wait 180 "$base")"
vm_ssh() {
  sshpass -p admin ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR "admin@$ip" "$@"
}
until vm_ssh true 2>/dev/null; do sleep 2; done
version="$(gh api repos/actions/runner/releases/latest --jq .tag_name)"
vm_ssh bash -s -- "${version#v}" <<'EOF'
set -euo pipefail
version=$1
as_root() { echo admin | sudo -S -p '' "$@"; }
/usr/bin/arch -x86_64 /usr/bin/true 2>/dev/null ||
  as_root softwareupdate --install-rosetta --agree-to-license
# Xcode brings Apple's intermediate certificates; without them a Developer ID identity is invalid.
for ca in DeveloperIDG2CA DeveloperIDCA; do
  curl -fsSL -o "/tmp/$ca.cer" "https://www.apple.com/certificateauthority/$ca.cer"
  as_root security add-certificates -k /Library/Keychains/System.keychain "/tmp/$ca.cer" 2>/dev/null || true
done
# An earlier setup registered a lasting runner here; each clone registers its own instead.
for plist in ~/Library/LaunchAgents/actions.runner.*.plist; do
  [[ -f "$plist" ]] || continue
  launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
  rm -f "$plist"
done
rm -rf ~/actions-runner
mkdir -p ~/actions-runner && cd ~/actions-runner
curl -fsSL "https://github.com/actions/runner/releases/download/v$version/actions-runner-osx-arm64-$version.tar.gz" | tar xz
sync
EOF
# Shutting down drops the connection, so ssh fails here.
vm_ssh "echo admin | sudo -S -p '' shutdown -h now" || true
wait "$pid" || true

mkdir -p "$support"
cat > "$support/loop.sh" <<'EOF'
#!/usr/bin/env bash
# One job at a time, each in a fresh clone of the prepared VM, registered for that job alone.
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
repo=$1 base=$2 label=$3
while true; do
  vm="$base-$(date +%s)"
  if tart clone "$base" "$vm"; then
    tart run --no-graphics "$vm" >/dev/null 2>&1 &
    pid=$!
    if ip="$(tart ip --wait 180 "$vm")"; then
      vm_ssh() {
        sshpass -p admin ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
          -o LogLevel=ERROR -o ServerAliveInterval=30 "admin@$ip" "$@"
      }
      for _ in $(seq 90); do vm_ssh true 2>/dev/null && break; sleep 2; done
      # The runner works in the logged-in session, where the launch check can open the app.
      vm_ssh "for _ in \$(seq 150); do who | grep -q '^admin *console' && exit 0; sleep 2; done
        exit 1" &&
        jit="$(gh api -X POST "repos/$repo/actions/runners/generate-jitconfig" -f name="$vm" \
          -F runner_group_id=1 -f "labels[]=$label" --jq .encoded_jit_config)" &&
        vm_ssh "echo admin | sudo -S -p '' launchctl asuser \$(id -u admin) sudo -u admin \
          /Users/admin/actions-runner/run.sh --jitconfig '$jit'" ||
        sleep 30
    fi
    tart stop "$vm" >/dev/null 2>&1
    wait "$pid"
    tart delete "$vm"
  else
    sleep 60
  fi
done
EOF
chmod +x "$support/loop.sh"
cat > "$agent" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.fork-mac-runner</string>
  <key>ProgramArguments</key><array>
    <string>$support/loop.sh</string><string>$repo</string><string>$base</string><string>$label</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$support/loop.log</string>
  <key>StandardErrorPath</key><string>$support/loop.log</string>
</dict></plist>
EOF
# A pull request's workflow could name the runner's label, so none may run without approval.
gh api -X PUT "repos/$repo/actions/permissions/fork-pr-contributor-approval" \
  -f approval_policy=all_external_contributors >/dev/null
launchctl bootstrap "gui/$(id -u)" "$agent"

echo "Waiting for the first runner to come online..."
for _ in $(seq 60); do
  if [[ -n "$(gh api "repos/$repo/actions/runners" \
    --jq '.runners[] | select(.name | startswith("mac-runner-")) | select(.status == "online") | .name')" ]]; then
    gh variable set FORK_MAC_RUNNER --repo "$repo" --body "$label"
    echo "The runner is online. Fork release now builds the macOS apps on this Mac."
    echo "Its log: $support/loop.log"
    exit 0
  fi
  sleep 5
done
echo "No runner came online; see $support/loop.log." >&2
exit 1
