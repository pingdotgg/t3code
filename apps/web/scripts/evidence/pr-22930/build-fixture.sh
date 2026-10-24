#!/usr/bin/env bash
# Builds the byte-stable fixture repo (fixed dates => fixed SHAs) at $EV_DIR/fixture/src.git.
set -euo pipefail
EV_DIR=${EV_DIR:-/tmp/ev-22930}
FX=$EV_DIR/fixture
rm -rf "$FX/src.git" "$FX/build"
mkdir -p "$FX"
git init -q -b main "$FX/build"
cd "$FX/build"
git config user.name Fixture
git config user.email fixture@example.invalid
n=0
commit() {
  n=$((n + 1))
  local d="2026-01-0${n}T12:00:00Z"
  git add -A
  GIT_AUTHOR_DATE=$d GIT_COMMITTER_DATE=$d git commit -q -m "$1"
}
lines() { # lines <prefix> <count>
  local i
  for ((i = 1; i <= $2; i++)); do echo "$1 line $i"; done
}
tsfn() { # tsfn <name> <count> <tag>
  local i
  for ((i = 1; i <= $2; i++)); do echo "export const ${1}_$i = \"$3 $i\";"; done
}

# base
echo 'export const one = 1;' >short-1.ts
echo '{"name": "fixture"}' >short-2.json
echo '# Notes' >short-3.md
echo 'key: value' >short-4.yml
tsfn longB 600 base >long-b.ts
lines "base doc" 300 >long-c.md
tsfn old 40 orig >old-name.ts
for i in 1 2 3 4 5 6 7; do echo "s$i base" >"s-$i.txt"; done
commit "base"

git checkout -q -b review-l
# C1: short-*, long-a.ts
printf 'export const one = 1;\nexport const two = 2;\nexport const three = 3;\n' >short-1.ts
printf '{"name": "fixture", "version": "1.0.0"}\n' >short-2.json
printf '# Notes\n\nSome notes.\n' >short-3.md
printf 'key: value\nother: thing\n' >short-4.yml
tsfn longA 420 added >long-a.ts
commit "C1: add long-a and touch short files"
# C2: long-b.ts, long-c.md, short-2.json, renamed.ts
awk 'NR % 10 == 5 { sub(/base/, "edited-c2") } { print }' long-b.ts >t && mv t long-b.ts
lines "c2 doc" 300 >long-c.md
printf '{"name": "fixture", "version": "1.1.0"}\n' >short-2.json
git mv old-name.ts renamed.ts
sed -i 's/orig 20"/renamed 20"/' renamed.ts
commit "C2: edit long-b, rewrite long-c, rename"
# C3: small edits to long-a.ts and short-4.yml
sed -i 's/added 10"/c3 10"/' long-a.ts
printf 'key: value\nother: c3\n' >short-4.yml
commit "C3: small follow-ups"

git checkout -q main
git checkout -q -b review-s
for i in 1 2 3; do printf "s$i base\ns$i one\ns$i two\n" >"s-$i.txt"; done
commit "S1: first three"
for i in 4 5; do printf "s$i base\ns$i one\ns$i two\ns$i three\n" >"s-$i.txt"; done
commit "S2: next two"
for i in 6 7; do printf "s$i base\ns$i alpha\n" >"s-$i.txt"; done
commit "S3: last two"

git checkout -q main
git clone -q --bare "$FX/build" "$FX/src.git"
cd "$FX" && rm -rf build
git -C "$FX/src.git" for-each-ref --format='%(refname:short) %(objectname)' refs/heads
