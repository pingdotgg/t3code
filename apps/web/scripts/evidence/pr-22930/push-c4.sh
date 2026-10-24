#!/usr/bin/env bash
# Adds commit C4 to review-l in the project A clone: edits expanded long-b.ts (lines 250-270)
# and collapsed short-1.ts. Default: commit only (press Push in the app). --external: also git push.
set -euo pipefail
EV_DIR=${EV_DIR:-/tmp/ev-22930}
cd "$EV_DIR/fixture/review-a"
for i in $(seq 250 270); do sed -i "s/\"\(base\|edited-c2\) $i\"/\"c4 $i\"/" long-b.ts; done
printf 'export const one = 1;\nexport const two = 2;\nexport const three = 3;\nexport const four = 4;\n' >short-1.ts
d=2026-01-10T12:00:00Z
git add -A
GIT_AUTHOR_DATE=$d GIT_COMMITTER_DATE=$d git commit -q -m "C4: new push"
git rev-parse HEAD
if [ "${1:-}" = "--external" ]; then git push -q origin review-l; fi
