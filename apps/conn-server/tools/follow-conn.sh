#!/usr/bin/env bash
# Brings the Conn Server up to the Conn monorepo it sits in: regenerates what is generated, runs
# tools/check.sh and prints a report a person can read in a minute. Run it after an upstream
# sync, or whenever a Conn Server check reports drift.
#
#   tools/follow-conn.sh [--since <commit>] [--capture] [--no-checks]
#
# --since      The Conn commit the report starts from. Default: the last commit that changed
#              apps/conn-server, the last time the Conn Server followed Conn.
# --capture    Also regenerate the provider crates' reference events (testdata/ts) from the
#              TypeScript adapters, and report which changed. Off by default: about 2 minutes.
# --no-checks  Skip tools/check.sh (quick look at the diff only; the report says so).
#
# It writes every generated file and never commits. It exits 1 when a generator or a check
# fails, and leaves the tree as it is for a person or an agent to fix. The full log and the
# report go to target/follow-conn/.
set -uo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo" || exit 1

die() {
  printf 'follow-conn: %s\n' "$*" >&2
  exit 2
}

since=""
capture=false
checks=true
while [ $# -gt 0 ]; do
  case "$1" in
    --capture) capture=true ;;
    --no-checks) checks=false ;;
    --since) since="${2:?--since needs a commit}"; shift ;;
    -h | --help) sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

mono="$(cd "$repo/../.." && pwd)"
[ -d "$mono/node_modules" ] || die "$mono has no node_modules: run vp i at the monorepo root"
new="$(git -C "$mono" rev-parse HEAD)" || die "$mono is not a Git checkout"
old="$(git -C "$mono" rev-parse --verify --quiet "${since:-$(git -C "$mono" log -1 --format=%H -- apps/conn-server)}^{commit}")" ||
  die "no commit ${since:-that changed apps/conn-server}"
untracked="$(git -C "$mono" ls-files --others --exclude-standard -- apps packages | head -n 5)"
[ -z "$untracked" ] ||
  printf 'follow-conn: warning: untracked files the generators may read, for example:\n%s\n' "$untracked" >&2

out="$repo/target/follow-conn"
mkdir -p "$out"
log="$out/${new:0:10}.log"
report="$out/${new:0:10}.report.txt"
: >"$log"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/conn-follow.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

# Every file a regeneration may rewrite. The report diffs the copies against the new state.
generated=(
  crates/conn-contract/src/generated.rs
  crates/conn-contract/tests/registry/mod.rs
  crates/conn-contract/generated/report.json
  crates/conn-contract/tests/fixtures/sampled.jsonl
  crates/conn-contract/methods.json
  crates/conn-preview/chrome.json
  crates/conn-preview/src/spec.json
  crates/conn-preview/src/injected.js
  crates/conn-preview/LICENSE.playwright
  crates/conn-preview/NOTICE.playwright
  crates/conn-mcp/src/catalog.jsonl
  crates/conn-mcp/src/instructions.txt
  crates/conn-mcp/src/claude-instructions.txt
  crates/conn-mcp/src/running-task-next.txt
  crates/conn-provider-codex/src/instructions.rs
  crates/conn-provider-codex/testdata/instructions.json
  crates/conn-provider-acp/src/instructions.rs
  crates/conn-provider-acp/testdata/instructions.json
  crates/conn-provider-claude/src/model_catalog.json
  crates/conn-server/keybindings.defaults.json
  crates/conn-server/keybindings.resolved.json
  crates/conn-server/src/scopes/generated.rs
  tools/upkeep/http-routes.json
  crates/conn-contract/src/upstream.rs
  crates/conn-server/src/settings/generated.rs
  tools/upkeep/mcp-tools.json
)
# The provider crates' reference events: what the TypeScript adapters emit for the recorded
# CLI transcripts. Only --capture rewrites them; the report then lists the files that changed.
reference_events=(
  crates/conn-provider-codex/testdata/cli
  crates/conn-provider-codex/testdata/ts
  crates/conn-provider-claude/testdata/ts
  crates/conn-provider-acp/testdata/grok
)
for rel in "${generated[@]}" "${reference_events[@]}"; do
  if [ -e "$rel" ]; then
    mkdir -p "$scratch/before/$(dirname "$rel")"
    cp -R "$rel" "$scratch/before/$rel"
  fi
done

printf 'follow-conn: Conn %s → %s (log: %s)\n' "${old:0:10}" "${new:0:10}" "$log" >&2
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

# 1. Regenerate. Each generator reads the monorepo this folder sits in.
step "gen-contract" node crates/conn-contract/tools/gen-contract.mjs
step "gen-tools" node crates/conn-mcp/tools/gen-tools.mjs
mcp_digests() {
  node crates/conn-mcp/tools/gen-tools.mjs --all "$scratch/mcp-all.json" &&
    node tools/bump-report.mjs --tool-digests "$scratch/mcp-all.json" tools/upkeep/mcp-tools.json
}
step "mcp tool list" mcp_digests
step "gen-keybindings" node crates/conn-server/tools/gen-keybindings.mjs
step "gen-upstream" node tools/gen-upstream.mjs
step "codex instructions" node crates/conn-provider-codex/tools/gen-instructions.mjs
step "acp instructions" node crates/conn-provider-acp/tools/gen-instructions.mjs
# The Claude model catalog comes from the T3 server's bundled catalog (about 30 s, vitest).
step "claude catalog" crates/conn-provider-claude/tools/gen-catalog/run.sh
# The keybinding files are formatted by hand; gen-keybindings --check compares values. Keep
# the committed layout when the value did not change, so an empty run leaves no diff.
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

# More Opaque fallbacks means the contract generator met a shape it cannot type: the run is
# red until gen-contract.mjs learns it.
opaque_fallbacks() {
  node -e '
    const fs = require("fs");
    const read = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")).opaqueFallbacks; } catch { return undefined; } };
    const [before, after] = process.argv.slice(1).map(read);
    console.log(`opaque fallbacks: ${before} -> ${after}`);
    process.exit(before !== undefined && after !== undefined && after > before ? 1 : 0);
  ' "$scratch/before/crates/conn-contract/generated/report.json" crates/conn-contract/generated/report.json
}
step "opaque fallbacks" opaque_fallbacks

# 2. Reference events from the TypeScript adapters: the provider crates' capture tools. Both
# replay recorded CLI transcripts (no model call), and both put a temporary test file into
# the monorepo's apps/server while they run, so run --capture only in your own checkout. The replay tests in `cargo test` then compare the Rust providers with the new
# events; the report lists which files changed.
capture_reference_events() {
  node crates/conn-provider-codex/tools/capture-ts-events.mjs &&
    crates/conn-provider-claude/tools/capture-ts/run.sh &&
    node crates/conn-provider-acp/tools/capture-ts-events.mjs grok &&
    node tools/reference-events.mjs "$scratch/before" "${reference_events[@]}" |
    tee "$scratch/reference-events"
}
if $capture; then
  # Before the checks, so `cargo test` replays against the new events.
  step "reference events (--capture)" capture_reference_events
fi

# 3. Checks.
if $checks; then
  printf '  ..    tools/check.sh (takes minutes)\n' >&2
  printf '\n==> tools/check.sh\n' >>"$log"
  CHECK_SUMMARY="$scratch/checks" tools/check.sh >>"$log" 2>&1
else
  printf 'skip tools/check.sh (--no-checks)\n' >"$scratch/checks"
fi
cat "$steps" "$scratch/checks" >"$scratch/all-checks"

# 4. Report.
binary="$repo/target/release/conn-server"
[ -x "$binary" ] || binary=""
node tools/bump-report.mjs --before "$scratch/before" --from "$old" --to "$new" \
  --checks "$scratch/all-checks" ${binary:+--binary "$binary"} $($capture && printf -- '--reference-events %s' "$scratch/reference-events") \
  >"$report" 2>>"$log"
cat "$report"
printf '\nreport: %s\nlog:    %s\n' "$report" "$log"
if ! $capture; then
  printf 'reference events (provider crates): not regenerated; pass --capture to regenerate and compare them.\n'
fi

if grep -q '^FAIL ' "$scratch/all-checks"; then
  printf '\nfollow-conn: RED. The tree keeps the regenerated state; fix it, then run tools/check.sh. Nothing was committed.\n'
  exit 1
fi
if ! $checks; then
  printf '\nfollow-conn: generators ok, checks not run (--no-checks). Run tools/check.sh before you commit.\n'
  exit 0
fi
printf '\nfollow-conn: green. Review the diff (git diff --stat), then commit. Nothing was committed.\n'
