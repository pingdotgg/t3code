#!/usr/bin/env bash
# Moves the pinned Conn commit, regenerates what is generated, runs tools/check.sh and prints
# a report a person can read in a minute. For the nightly bot and for people.
#
#   CONN_MONOREPO=<Conn checkout at the new commit, after vp i> tools/bump-conn.sh [<commit>]
#       [--capture] [--no-checks]
#
# <commit>     Default: HEAD of CONN_MONOREPO. CONN_MONOREPO must be at it
#              (tools/conn-checkout --commit <sha> --dest <dir> moves a checkout there).
# --capture    Also regenerate the provider crates' reference events from the TypeScript
#              adapters (see capture_reference_events below). Off by default.
# --no-checks  Skip tools/check.sh (quick look at the diff only; the report says so).
#
# It writes conn.pin, the README's base line and every generated file, and never commits. It
# exits 1 when a generator or a check fails, and leaves the tree as it is for a person or an
# agent to fix. The full log and the report go to target/bump-conn/.
set -uo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo" || exit 1

die() {
  printf 'bump-conn: %s\n' "$*" >&2
  exit 2
}

target=""
capture=false
checks=true
while [ $# -gt 0 ]; do
  case "$1" in
    --capture) capture=true ;;
    --no-checks) checks=false ;;
    -h | --help) sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown flag: $1" ;;
    *) [ -z "$target" ] || die "one commit only"; target="$1" ;;
  esac
  shift
done

[ -n "${CONN_MONOREPO:-}" ] || die "CONN_MONOREPO is not set: point it at a Conn checkout after vp i (tools/conn-checkout makes one)"
mono="$(cd "$CONN_MONOREPO" 2>/dev/null && pwd)" || die "CONN_MONOREPO=$CONN_MONOREPO does not exist"
[ -d "$mono/node_modules" ] || die "$mono has no node_modules: run vp i there (or tools/conn-checkout)"
head="$(git -C "$mono" rev-parse HEAD)" || die "$mono is not a Git checkout"
new="$(git -C "$mono" rev-parse --verify --quiet "${target:-HEAD}^{commit}")" || die "no commit ${target} in $mono"
[ "$new" = "$head" ] ||
  die "CONN_MONOREPO is at ${head:0:10}, not ${new:0:10}: run tools/conn-checkout --commit $new --dest $mono"
git -C "$mono" diff --quiet HEAD -- ||
  printf 'bump-conn: warning: %s has changes to tracked files; the generated files follow them\n' "$mono" >&2

old="$(head -n 1 conn.pin 2>/dev/null | tr -d '[:space:]')"
[ -n "$old" ] || die "no commit in conn.pin"

out="$repo/target/bump-conn"
mkdir -p "$out"
log="$out/${new:0:10}.log"
report="$out/${new:0:10}.report.txt"
: >"$log"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/conn-bump.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

# Every file the bump may rewrite. The report diffs the copies against the new state.
generated=(
  crates/conn-contract/src/generated.rs
  crates/conn-contract/tests/registry/mod.rs
  crates/conn-contract/generated/report.json
  crates/conn-contract/tests/fixtures/sampled.jsonl
  crates/conn-contract/methods.json
  crates/conn-mcp/src/catalog.jsonl
  crates/conn-mcp/src/instructions.txt
  crates/conn-mcp/src/claude-background-wait.txt
  crates/conn-server/keybindings.defaults.json
  crates/conn-server/keybindings.resolved.json
  crates/conn-server/src/scopes/generated.rs
  tools/upkeep/http-routes.json
  crates/conn-contract/src/upstream.rs
  crates/conn-server/src/settings/generated.rs
  tools/upkeep/mcp-tools.json
)
for rel in "${generated[@]}"; do
  if [ -f "$rel" ]; then
    mkdir -p "$scratch/before/$(dirname "$rel")"
    cp "$rel" "$scratch/before/$rel"
  fi
done

printf 'bump-conn: %s → %s (log: %s)\n' "${old:0:10}" "${new:0:10}" "$log" >&2
steps="$scratch/steps"
: >"$steps"
step() {
  local name="$1"
  shift
  printf '\n==> %s\n' "$name" >>"$log"
  if "$@" >>"$log" 2>&1; then
    printf 'ok %s\n' "$name" >>"$steps"
    printf '  ok    %s\n' "$name" >&2
  else
    printf 'FAIL %s\n' "$name" >>"$steps"
    printf '  FAIL  %s (see the log)\n' "$name" >&2
  fi
}

# 1. The pin: conn.pin is the one source; the README names it for readers.
write_pin() {
  printf '%s\n' "$new" >conn.pin
  local date
  date="$(git -C "$mono" log -1 --format=%cs "$new")"
  # Only the base line; the rest of the README is prose a person keeps.
  sed -e "s|^\*\*Base:\*\* Conn .*|**Base:** Conn \`origin/main\` at \`$new\` ($date). \`conn.pin\` holds it.|" \
    README.md >"$scratch/README.md" && cat "$scratch/README.md" >README.md
}
step "write conn.pin" write_pin

# 2. Regenerate. Each generator reads CONN_MONOREPO.
export CONN_MONOREPO="$mono"
step "gen-contract" node crates/conn-contract/tools/gen-contract.mjs
step "gen-tools" node crates/conn-mcp/tools/gen-tools.mjs
mcp_digests() {
  node crates/conn-mcp/tools/gen-tools.mjs --all "$scratch/mcp-all.json" &&
    node tools/bump-report.mjs --tool-digests "$scratch/mcp-all.json" tools/upkeep/mcp-tools.json
}
step "mcp tool list" mcp_digests
step "gen-keybindings" node crates/conn-server/tools/gen-keybindings.mjs
step "gen-upstream" node tools/gen-upstream.mjs
# The keybinding files are formatted by hand; gen-keybindings --check compares values. Keep
# the committed layout when the value did not change, so an empty bump leaves no diff.
keep_layout() {
  local rel
  for rel in crates/conn-server/keybindings.defaults.json crates/conn-server/keybindings.resolved.json; do
    [ -f "$scratch/before/$rel" ] || continue
    if node -e 'const fs = require("fs"); const [a, b] = process.argv.slice(1).map((f) => JSON.stringify(JSON.parse(fs.readFileSync(f, "utf8")))); process.exit(a === b ? 0 : 1)' \
      "$scratch/before/$rel" "$rel"; then
      cp "$scratch/before/$rel" "$rel"
    fi
  done
}
step "keybinding layout" keep_layout

# 3. Reference events from the TypeScript adapters. This is the one place to call the
# provider crates' capture tools. Both replay recorded CLI transcripts (no model call), and
# both put a temporary test file into CONN_MONOREPO/apps/server while they run, so never
# point CONN_MONOREPO at a shared checkout with --capture.
capture_reference_events() {
  # Not hooked in yet: the provider crates own these tools and are changing them. When they
  # are stable, replace this body with:
  #   node crates/conn-provider-codex/tools/capture-ts-events.mjs &&
  #     CONN_MONOREPO="$mono" crates/conn-provider-claude/tools/capture-ts/run.sh
  # and add their testdata/ts directories to `generated` above.
  printf 'capture tools are not hooked in yet (tools/bump-conn.sh, capture_reference_events)\n'
  return 1
}
if $capture; then
  step "reference events" capture_reference_events
fi

# 4. Checks.
if $checks; then
  printf '  ..    tools/check.sh (takes minutes)\n' >&2
  printf '\n==> tools/check.sh\n' >>"$log"
  CHECK_SUMMARY="$scratch/checks" tools/check.sh >>"$log" 2>&1
else
  printf 'skip tools/check.sh (--no-checks)\n' >"$scratch/checks"
fi
cat "$steps" "$scratch/checks" >"$scratch/all-checks"

# 5. Report.
binary="$repo/target/release/conn-server"
[ -x "$binary" ] || binary=""
node tools/bump-report.mjs --before "$scratch/before" --from "$old" --to "$new" \
  --checks "$scratch/all-checks" ${binary:+--binary "$binary"} >"$report" 2>>"$log"
cat "$report"
printf '\nreport: %s\nlog:    %s\n' "$report" "$log"
if ! $capture; then
  printf 'reference events (provider crates): not regenerated; pass --capture once it is hooked in.\n'
fi

if grep -q '^FAIL ' "$scratch/all-checks"; then
  printf '\nbump-conn: RED. The tree keeps the bumped state; fix it, then run tools/check.sh. Nothing was committed.\n'
  exit 1
fi
if ! $checks; then
  printf '\nbump-conn: generators ok, checks not run (--no-checks). Run tools/check.sh before you commit.\n'
  exit 0
fi
printf '\nbump-conn: green. Review the diff (git diff --stat), then commit. Nothing was committed.\n'
