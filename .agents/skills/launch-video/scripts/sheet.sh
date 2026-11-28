#!/usr/bin/env bash
# Captures frames at the given real-time seconds and tiles them into one contact sheet.
# Usage: sheet.sh <dir> <seconds,...> [out.png]   (frames land in <dir>/probe, sheet in <dir>/sheet.png)
set -euo pipefail
dir=$(cd "${1:?usage: sheet.sh <dir> <seconds,...> [out.png]}" && pwd)
times=${2:?give comma-separated seconds, e.g. 1,4.5,9}
out=${3:-$dir/sheet.png}
here=$(cd "$(dirname "$0")" && pwd)
rm -rf "$dir/probe"
node "$here/capture.mjs" "$dir/story.html" "$dir/probe" --at "$times"
n=$(ls "$dir/probe"/*.png | wc -l)
cols=$(( n < 3 ? n : 3 )); rows=$(( (n + cols - 1) / cols ))
# Chromium saves some frames as RGBA and others as RGB; without -reinit_filter 0 the
# format change restarts the tile filter and the sheet silently loses frames.
ffmpeg -hide_banner -loglevel error -y -reinit_filter 0 -pattern_type glob -i "$dir/probe/*.png" \
  -vf "format=rgb24,scale=960:-1,tile=${cols}x${rows}:padding=8:color=0x333333" -frames:v 1 -update 1 "$out"
echo "sheet -> $out ($n frames; full-size frames in $dir/probe)"
