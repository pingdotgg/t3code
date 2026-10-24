#!/usr/bin/env bash
# For every *-before.png in <dir> with a matching *-after.png, writes two diff images:
#   *-diff.png  pixel diff: changed pixels in red over a faded copy of the before image
#   *-sbs.png   labeled side-by-side: Before | After | Diff
# Usage: diff.sh <stillsDir> [outDir]
set -u
dir="$1"; out="${2:-$1/diffs}"
mkdir -p "$out"
for before in "$dir"/*-before.png; do
  after="${before%-before.png}-after.png"
  [ -f "$after" ] || continue
  stem="$(basename "${before%-before.png}")"
  # compare exits 1 when images differ; that is the expected case.
  pixels=$(compare -metric AE -fuzz 2% -highlight-color red -lowlight-color '#ffffff40' "$before" "$after" "$out/$stem-diff.png" 2>&1 >/dev/null || true)
  montage -label 'BEFORE (3b95e78)' "$before" -label 'AFTER (1ce968c)' "$after" -label "DIFF ($pixels px differ)" "$out/$stem-diff.png" \
    -tile 3x1 -geometry +12+12 -pointsize 22 -background '#e8e8e8' "$out/$stem-sbs.png"
  echo "$stem $pixels"
done
