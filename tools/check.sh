#!/usr/bin/env bash
# Runs every check that needs no model, in order, and prints a summary.
# Usage: CONN_MONOREPO=/path/to/conn tools/check.sh
# Without CONN_MONOREPO it runs the Rust-only checks and lists what it skipped.
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

run() {
  local name="$1"
  shift
  printf '\n==> %s\n' "$name"
  local started=$SECONDS
  if "$@"; then
    passed+=("$name")
    printf '<== ok    %s (%ss)\n' "$name" $((SECONDS - started))
  else
    failed+=("$name")
    printf '<== FAIL  %s (%ss)\n' "$name" $((SECONDS - started))
  fi
}

client_check() {
  cargo run --quiet --release -p conn-engine --features fake-provider --example export_turn \
    -- "$scratch/export.json" &&
    node crates/conn-engine/tools/client-check.mjs "$scratch/export.json"
}

run "cargo fmt --check" cargo fmt --check
run "cargo clippy" cargo clippy --workspace --all-targets -- -D warnings
run "cargo test" cargo test --workspace
run "release build" cargo build --release --workspace --bins --examples
run "decode check" env CARGO_TARGET_DIR="$repo/target" \
  cargo test --manifest-path fixtures/decode-check/Cargo.toml

monorepo_checks=(
  "gen-contract --check"
  "gen-tools --check"
  "gen-keybindings --check"
  "effect-client (conn-server)"
  "effect-client (ack window)"
  "client-check"
  "replay"
  "parity"
)

if [ -z "${CONN_MONOREPO:-}" ]; then
  printf '\nCONN_MONOREPO is not set: skipping the checks that need the Conn monorepo.\n'
  skipped=("${monorepo_checks[@]}")
else
  run "gen-contract --check" node crates/conn-contract/tools/gen-contract.mjs --check
  run "gen-tools --check" node crates/conn-mcp/tools/gen-tools.mjs --check
  run "gen-keybindings --check" node crates/conn-server/tools/gen-keybindings.mjs --check
  run "effect-client (conn-server)" \
    node crates/conn-server/tools/effect-client.mjs "$release/conn-server"
  run "effect-client (ack window)" \
    node crates/conn-server/tools/effect-client.mjs "$release/examples/effect_fixture" --fixture
  run "client-check" client_check
  run "replay" node crates/conn-server/tools/replay.mjs "$release/examples/replay_server"
  run "parity" \
    node crates/conn-mcp/tools/parity.mjs "$release/examples/replay_server"
fi
# orbit-flow needs no monorepo.
run "orbit-flow (fake provider)" \
  node crates/conn-server/tools/orbit-flow.mjs "$release/examples/replay_server"

printf '\n== Summary\n'
printf 'passed  %d\n' "${#passed[@]}"
for name in "${failed[@]+"${failed[@]}"}"; do printf 'FAILED  %s\n' "$name"; done
for name in "${skipped[@]+"${skipped[@]}"}"; do
  printf 'skipped %s (needs CONN_MONOREPO)\n' "$name"
done
[ "${#failed[@]}" -eq 0 ]
