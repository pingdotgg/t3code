#!/usr/bin/env bash
# Captures one app window (with its shadow off) to a PNG for visual verification.
#
#   scripts/shot.sh <owner-name> <out.png>      e.g. scripts/shot.sh conn-app .shots/dark.png
#   scripts/shot.sh --list                       list on-screen windows (owner, id, bounds)
#
# Finds the window through CGWindowListCopyWindowInfo and captures it with `screencapture -l`.
set -euo pipefail

list_windows() {
  /usr/bin/swift - <<'SWIFT'
import CoreGraphics
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
let info = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] ?? []
for w in info {
  let owner = w[kCGWindowOwnerName as String] as? String ?? ""
  let id = w[kCGWindowNumber as String] as? Int ?? 0
  let layer = w[kCGWindowLayer as String] as? Int ?? 0
  let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
  let width = b["Width"] as? Double ?? 0
  let height = b["Height"] as? Double ?? 0
  if layer == 0 && width > 200 && height > 200 {
    print("\(owner)\t\(id)\t\(Int(width))x\(Int(height))")
  }
}
SWIFT
}

if [[ "${1:-}" == "--list" ]]; then
  list_windows
  exit 0
fi

owner="${1:?owner name}"
out="${2:?output png}"
id=$(list_windows | awk -F'\t' -v o="$owner" '$1 == o { print $2; exit }')
if [[ -z "$id" ]]; then
  echo "no on-screen window owned by '$owner'" >&2
  list_windows >&2
  exit 1
fi
mkdir -p "$(dirname "$out")"
screencapture -x -o -l "$id" "$out"
echo "$out"
