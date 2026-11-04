#!/usr/bin/env bash
# Scratch driver for issue 30662 captures. Not part of the PR.
# Usage: capture-driver.sh <session> <out-dir> <label> <project-title> <light|dark>
# Opens the new-thread draft for <project-title> (environment default: New worktree),
# types a prompt, dismisses the keyboard, waits for a settled frame, and captures it
# with the accessibility snapshot alongside.
set -euo pipefail
s="$1"; out="$2"; label="$3"; project="$4"; theme="$5"
A=(agent-device --session "$s")
mkdir -p "$out"
ref() { "${A[@]}" snapshot -i 2>&1 | grep -oE "@e[0-9]+ \[$1\] \"$2" | head -1 | cut -d' ' -f1; }

"${A[@]}" settings animations off >/dev/null
"${A[@]}" settings appearance "$theme" >/dev/null
sleep 2
# Back to the thread list.
for _ in 1 2 3; do
  up=$(ref button "Navigate up" || true)
  [ -z "$up" ] && break
  "${A[@]}" press "$up" >/dev/null; sleep 2
done
fab=$("${A[@]}" snapshot -i 2>&1 | grep -oE '@e[0-9]+ \[button\] "New thread"' | tail -1 | cut -d' ' -f1)
"${A[@]}" press "$fab" >/dev/null; sleep 3
hero=""
for _ in $(seq 1 15); do
  hero=$("${A[@]}" snapshot -i 2>&1 | grep -A1 '\[text\] "in"$' | grep -oE '@e[0-9]+ \[button\]' | head -1 | cut -d' ' -f1 || true)
  [ -n "$hero" ] && break
  sleep 1
done
"${A[@]}" press "$hero" >/dev/null; sleep 3
"${A[@]}" press "$(ref button "$project,")" >/dev/null; sleep 5
field=$(ref text-field 'Ask anything')
"${A[@]}" fill "$field" "Summarize the character rig" >/dev/null; sleep 1
"${A[@]}" keyboard dismiss >/dev/null 2>&1 || true
sleep 2
# Settled frame: two shots 500 ms apart must be pixel-identical.
for _ in 1 2 3 4 5 6; do
  "${A[@]}" screenshot "$out/.a.png" >/dev/null; sleep 0.5
  "${A[@]}" screenshot "$out/.b.png" >/dev/null
  # Mask the status bar clock row (top 130px) so the time cannot block settling.
  convert "$out/.a.png" -crop +0+130 +repage "$out/.ac.png"
  convert "$out/.b.png" -crop +0+130 +repage "$out/.bc.png"
  d=$(compare -metric AE "$out/.ac.png" "$out/.bc.png" null: 2>&1 || true)
  rm -f "$out/.ac.png" "$out/.bc.png"
  [ "$d" = "0" ] && break
  sleep 1
done
mv "$out/.b.png" "$out/$label.png"; rm -f "$out/.a.png"
"${A[@]}" snapshot -i > "$out/$label.snapshot.txt" 2>&1
grep -iE 'worktree|checkout|branch|send|Choose a base' "$out/$label.snapshot.txt" || true
echo "captured $out/$label.png (settle diff: $d)"
