#!/usr/bin/env bash
# Runs every check that needs no model, in order, and prints a summary.
# Usage: CONN_MONOREPO=/path/to/conn tools/check.sh
# Without CONN_MONOREPO it runs the Rust-only checks and lists what it skipped.
# CHECK_SUMMARY=<file> also writes one line per check (`ok <name>`, `FAIL <name>`,
# `skip <name>`) to that file, for tools/bump-conn.sh.
# No check calls a model: the server checks use `examples/replay_server` (the engine's fake
# provider), and `parity.mjs` calls none by default. Every server gets a temp state folder.
set -u

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo" || exit 1

release="$repo/target/release"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/conn-check.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

passed=()
failed=()
skipped=()
skipped_tools=()
summary="${CHECK_SUMMARY:-/dev/null}"
: >"$summary"

run() {
  local name="$1"
  shift
  printf '\n==> %s\n' "$name"
  local started=$SECONDS
  if "$@"; then
    passed+=("$name")
    printf 'ok %s\n' "$name" >>"$summary"
    printf '<== ok    %s (%ss)\n' "$name" $((SECONDS - started))
  else
    failed+=("$name")
    printf 'FAIL %s\n' "$name" >>"$summary"
    printf '<== FAIL  %s (%ss)\n' "$name" $((SECONDS - started))
  fi
}

client_check() {
  cargo run --quiet --release -p conn-engine --features fake-provider --example export_turn \
    -- "$scratch/export.json" &&
    node crates/conn-engine/tools/client-check.mjs "$scratch/export.json"
}

# CI installs the toolchain by name; it must be the one rust-toolchain.toml pins.
toolchain_pin() {
  local pinned ci
  pinned="$(sed -n 's/^channel = "\(.*\)"$/\1/p' rust-toolchain.toml)"
  ci="$(sed -n 's/^  RUST_TOOLCHAIN: "\(.*\)"$/\1/p' .github/workflows/ci.yml)"
  if [ -z "$pinned" ] || [ "$pinned" != "$ci" ]; then
    printf 'rust-toolchain.toml pins %s; .github/workflows/ci.yml installs %s\n' "$pinned" "$ci"
    return 1
  fi
}

run "toolchain pin" toolchain_pin
run "cargo fmt --check" cargo fmt --check
run "cargo clippy" cargo clippy --workspace --all-targets --all-features -- -D warnings
run "cargo test" cargo test --workspace
run "release build" cargo build --release --workspace --bins --examples
run "decode check" env CARGO_TARGET_DIR="$repo/target" \
  cargo test --manifest-path fixtures/decode-check/Cargo.toml

# Advisories, licences, bans and sources (deny.toml). Advisories need network access for the
# RustSec database; DENY_OFFLINE=1 (`cargo deny --offline`) uses the cached copy.
if command -v cargo-deny >/dev/null 2>&1; then
  run "cargo deny" cargo deny --locked ${DENY_OFFLINE:+--offline} check
else
  printf '\ncargo-deny is not installed: skipping `cargo deny check` (cargo install cargo-deny --locked).\n'
  skipped_tools+=("cargo deny")
fi

monorepo_checks=(
  "gen-contract --check"
  "gen-tools --check"
  "gen-keybindings --check"
  "gen-upstream --check"
  "check-copies"
  "effect-client (conn-server)"
  "effect-client (ack window)"
  "client-check"
  "replay"
  "decode coverage"
  "settings-diff"
  "limits-diff"
  "parity"
  "codex instructions --check"
  "codex conformance"
  "claude catalog --check"
  "claude conformance"
  "claude t3-replay"
  "acp instructions --check"
  "acp conformance"
)

if [ -z "${CONN_MONOREPO:-}" ]; then
  printf '\nCONN_MONOREPO is not set: skipping the checks that need the Conn monorepo.\n'
  skipped=("${monorepo_checks[@]}")
else
  run "gen-contract --check" node crates/conn-contract/tools/gen-contract.mjs --check
  run "gen-tools --check" node crates/conn-mcp/tools/gen-tools.mjs --check
  run "gen-keybindings --check" node crates/conn-server/tools/gen-keybindings.mjs --check
  run "gen-upstream --check" node tools/gen-upstream.mjs --check
  run "check-copies" node tools/check-copies.mjs
  decoded="$scratch/decoded-tags"
  : >"$decoded"
  run "effect-client (conn-server)" \
    env DECODE_COVERAGE="$decoded" node crates/conn-server/tools/effect-client.mjs "$release/conn-server"
  run "effect-client (ack window)" \
    node crates/conn-server/tools/effect-client.mjs "$release/examples/effect_fixture" --fixture
  run "client-check" client_check
  # Every recording in fixtures/sessions (about 15 s).
  scenarios=()
  for file in fixtures/sessions/*.ndjson; do
    case "$file" in *.http.ndjson) continue ;; esac
    name="${file##*/}"
    scenarios+=("${name%.ndjson}")
  done
  run "replay" env DECODE_COVERAGE="$decoded" \
    node crates/conn-server/tools/replay.mjs "$release/examples/replay_server" "${scenarios[@]}"
  run "decode coverage" \
    node crates/conn-server/tools/decode-coverage.mjs "$decoded" "$release/conn-server"
  run "settings-diff" node crates/conn-server/tools/settings-diff.mjs "$release/conn-server"
  run "limits-diff" node crates/conn-server/tools/limits-diff.mjs
  run "parity" \
    node crates/conn-mcp/tools/parity.mjs "$release/examples/replay_server"
  run "codex instructions --check" \
    node crates/conn-provider-codex/tools/gen-instructions.mjs --check
  run "codex conformance" node crates/conn-provider-codex/tools/conformance.mjs
  run "claude catalog --check" crates/conn-provider-claude/tools/gen-catalog/run.sh --check
  # The Claude conformance check runs the real Agent SDK in the SDK host, so it needs
  # `npm ci` in helpers/sdk-host. Without it the check is skipped, never counted as passed.
  if [ -d helpers/sdk-host/node_modules/@anthropic-ai/claude-agent-sdk ]; then
    run "claude conformance" crates/conn-provider-claude/tools/conformance/run.sh
  else
    printf '\nhelpers/sdk-host has no node_modules: skipping claude conformance (run npm ci in helpers/sdk-host).\n'
    skipped_tools+=("claude conformance")
  fi
  # Exactly the scenarios in expected-failures.txt may fail; any other change fails the check.
  run "claude t3-replay" node crates/conn-provider-claude/tools/t3-replay/check.mjs
  # The T3 Grok adapter and conn-provider-acp against one stub agent (no agent, no model).
  run "acp instructions --check" node crates/conn-provider-acp/tools/gen-instructions.mjs --check
  run "acp conformance" node crates/conn-provider-acp/tools/conformance.mjs
fi
# orbit-flow needs no monorepo.
run "orbit-flow (fake provider)" \
  node crates/conn-server/tools/orbit-flow.mjs "$release/examples/replay_server"

printf '\n== Summary\n'
printf 'passed  %d\n' "${#passed[@]}"
for name in "${failed[@]+"${failed[@]}"}"; do printf 'FAILED  %s\n' "$name"; done
for name in "${skipped[@]+"${skipped[@]}"}"; do
  printf 'skipped %s (needs CONN_MONOREPO)\n' "$name"
  printf 'skip %s\n' "$name" >>"$summary"
done
for name in "${skipped_tools[@]+"${skipped_tools[@]}"}"; do
  printf 'skipped %s (a tool or npm ci is missing; see above)\n' "$name"
  printf 'skip %s\n' "$name" >>"$summary"
done
[ "${#failed[@]}" -eq 0 ]
