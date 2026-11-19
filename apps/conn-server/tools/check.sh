#!/usr/bin/env bash
# Runs every check that needs no model, in order, and prints a summary.
# Usage: tools/check.sh [--group build|rust|1|2|3|4]
# The Node tools read the contract, the web client and apps/server from the Conn monorepo this
# folder sits in (two levels up); run `vp i` at the monorepo root first.
# CHECK_SUMMARY=<file> also writes one line per check (`ok <name>`, `FAIL <name>`,
# `skip <name>`) to that file, for tools/follow-conn.sh.
# No check calls a model: the server checks use `examples/replay_server` (the engine's fake
# provider), and `parity.mjs` calls none by default. Every server gets a temp state folder.
set -u
group=all
if [ "$#" -ne 0 ]; then
  if [ "$#" -ne 2 ] || [ "$1" != --group ]; then
    echo "Usage: tools/check.sh [--group build|rust|1|2|3|4]" >&2
    exit 2
  fi
  case "$2" in build|rust|1|2|3|4) group="$2" ;; *) echo "Unknown check group: $2" >&2; exit 2 ;; esac
fi
# The way out of the sealed cargo runner (tools/cargo-runner.mjs) is for hand runs only.
if [ -n "${CONN_UNSEALED:-}" ]; then
  echo "tools/check.sh: CONN_UNSEALED is set; checks never run unsealed. Unset it." >&2
  exit 1
fi
# No check reaches the network for the model manifest: every server a check starts inherits
# this (crates/conn-server/src/model_manifest.rs, the test seam), whatever the shell has.
export CONN_MODEL_MANIFEST_URL=off

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
monorepo="$(cd "$repo/../.." && pwd)"
cd "$repo" || exit 1
. tools/check-timeout.sh
if [ ! -d "$monorepo/node_modules" ]; then
  echo "tools/check.sh: $monorepo has no node_modules; run vp i at the monorepo root first." >&2
  exit 1
fi

release="${CONN_CHECK_BINARIES:-$repo/target}/release"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/conn-check.XXXXXX")"

# The canary (tools/canary.mjs): every check runs with a decoy HOME, marker variables in the
# shell, a stand-in SHELL and a TMPDIR the canary watches. The last check fails when a check
# read a decoy file, changed the decoy home, or let a marker reach its output or a file.
# Cargo and rustup keep their real folders, named here before HOME changes.
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
canary="$(mktemp -d /tmp/conn-canary.XXXXXX)"
canary_log="$canary/output.log"
canary_watch=""
cleanup() {
  [ -n "$canary_watch" ] && kill "$canary_watch" 2>/dev/null
  rm -rf "$scratch" "$canary"
}
trap cleanup EXIT
node tools/canary.mjs setup "$canary" || exit 1
# shellcheck source=/dev/null
. "$canary/env.sh"
: >"$canary_log"
node tools/canary.mjs watch "$canary" &
canary_watch=$!

# Cargo reads ~/.gitconfig through HOME (its git library ignores GIT_CONFIG_GLOBAL), so cargo
# runs with a throwaway HOME. A target runner gives the test and example binaries it starts
# the decoy HOME back, so the canary still sees what the code under test reads; their `git`
# runs get no global or system git configuration. This runner, set in the environment, wins
# over the sealed runner in .cargo/config.toml (proved by the sealed-run check): here the
# binaries must see the decoys, or the canary would prove nothing about the code. Tools that
# run cargo themselves drop it (sealedCargoEnv) and get the sealed runner.
canary_cargo_home="$canary/cargo-home"
mkdir -p "$canary_cargo_home"
cat >"$canary/runner" <<'RUNNER'
#!/bin/sh
if [ "$HOME" = "$CONN_CANARY_CARGO_HOME" ]; then HOME="$CONN_CANARY_TEST_HOME"; export HOME; fi
exec "$@"
RUNNER
chmod +x "$canary/runner"
canary_host="$(rustc -vV | sed -n 's/^host: //p' | tr 'a-z.-' 'A-Z__')"
export "CARGO_TARGET_${canary_host}_RUNNER=$canary/runner"
export CONN_CANARY_CARGO_HOME="$canary_cargo_home" CONN_CANARY_TEST_HOME="$HOME"
cargo() {
  HOME="$canary_cargo_home" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 command cargo "$@"
}

passed=()
failed=()
skipped_tools=()
summary="${CHECK_SUMMARY:-/dev/null}"
: >"$summary"

run() {
  local check_group="$1" limit="$2" name="$3"
  shift 3
  [ "$group" = all ] || [ "$group" = "$check_group" ] || [ "$check_group" = always ] || return 0
  printf '\n==> %s\n' "$name"
  local started=$SECONDS status
  check_timeout "$limit" "$@" 2>&1 | tee -a "$canary_log"
  status=${PIPESTATUS[0]}
  node tools/canary.mjs mark "$canary" "$name"
  if [ "$status" -eq 0 ]; then
    passed+=("$name")
    printf 'ok %s\n' "$name" >>"$summary"
    printf '<== ok    %s (%ss)\n' "$name" $((SECONDS - started))
  else
    failed+=("$name")
    if [ "$status" -eq 124 ]; then
      printf 'FAIL %s\n' "$name" >>"$summary"
      printf '<== TIMEOUT %s (%ss, limit %ss)\n' "$name" "$((SECONDS - started))" "$limit"
    else
      printf 'FAIL %s\n' "$name" >>"$summary"
      printf '<== FAIL  %s (%ss)\n' "$name" $((SECONDS - started))
    fi
  fi
}

client_check() {
  local binary
  binary="$(node tools/check-binaries.mjs conn-engine export_turn)" &&
    GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 "$canary/runner" "$binary" "$scratch/export.json" &&
    node crates/conn-engine/tools/client-check.mjs "$scratch/export.json"
}

# CI and the release build install the toolchain by name; it must be the one
# rust-toolchain.toml pins. The workflows live in the monorepo's .github.
toolchain_pin() {
  local pinned ci workflow
  pinned="$(sed -n 's/^channel = "\(.*\)"$/\1/p' rust-toolchain.toml)"
  for workflow in "$monorepo"/.github/workflows/conn-server-{ci,checks,release}.yml; do
    ci="$(sed -n 's/^  RUST_TOOLCHAIN: "\(.*\)"$/\1/p' "$workflow")"
    if [ -z "$pinned" ] || [ "$pinned" != "$ci" ]; then
      printf 'rust-toolchain.toml pins %s; %s installs %s\n' "$pinned" "$workflow" "$ci"
      return 1
    fi
  done
}

run rust 30 "timeout wrapper" bash tools/check-timeout.test.sh
run rust 60 "toolchain pin" toolchain_pin
run rust 120 "cargo fmt --check" cargo fmt --check
run rust 600 "cargo clippy" cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
run rust 900 "cargo test" cargo test --locked --workspace --no-fail-fast
if [ "$group" = all ]; then
  run rust 1200 "release build" cargo build --release --workspace --bins --examples --features fake-provider
fi
decode_check() {
  CARGO_TARGET_DIR="$repo/target" cargo test --locked --manifest-path fixtures/decode-check/Cargo.toml
}
run rust 300 "decode check" decode_check
if [ "$group" = build ]; then
  run build 1200 "comparison binaries" node tools/check-binaries.mjs --build "$repo/target/check-binaries" "${CONN_CHECK_BUILD_PROFILE:-all}" "${CONN_CHECK_BUILD_PACKAGE:-all}"
fi

# Advisories, licences, bans and sources (deny.toml). Advisories need network access for the
# RustSec database; DENY_OFFLINE=1 (`cargo deny --offline`) uses the cached copy.
if [ "$group" != all ] && [ "$group" != rust ]; then
  :
elif command -v cargo-deny >/dev/null 2>&1; then
  run rust 300 "cargo deny" cargo deny --locked ${DENY_OFFLINE:+--offline} check
else
  printf '\ncargo-deny is not installed: skipping `cargo deny check` (cargo install cargo-deny --locked).\n'
  skipped_tools+=("cargo deny")
fi

# The checks against the monorepo: its contract, apps/server and the web client.
run 2 120 "gen-contract --check" node crates/conn-contract/tools/gen-contract.mjs --check
run 2 120 "gen-tools --check" node crates/conn-mcp/tools/gen-tools.mjs --check
run 2 120 "gen-keybindings --check" node crates/conn-server/tools/gen-keybindings.mjs --check
run 2 120 "gen-upstream --check" node tools/gen-upstream.mjs --check
# GitHub's GraphQL operation texts, printed from T3's generated modules by effect/graphql.
run 2 120 "gen-graphql --check" node crates/conn-source-control/tools/gen-graphql.mjs --check
run 2 120 "PR characterizations" node crates/conn-source-control/tools/gen-pr-cases.mjs --check
run 2 120 "check-copies" node tools/check-copies.mjs
decoded="$scratch/decoded-tags"
: >"$decoded"
run 4 120 "effect-client (conn-server)" \
  env DECODE_COVERAGE="$decoded" node crates/conn-server/tools/effect-client.mjs "$release/conn-server"
run 4 120 "effect-client (ack window)" \
  env DECODE_COVERAGE="$decoded" node crates/conn-server/tools/effect-client.mjs "$release/examples/effect_fixture" --fixture
run 4 300 "client-check" client_check
# Every recording in fixtures/sessions (about 15 s).
scenarios=()
for file in fixtures/sessions/*.ndjson; do
  case "$file" in *.http.ndjson) continue ;; esac
  name="${file##*/}"
  scenarios+=("${name%.ndjson}")
done
run 4 120 "replay" env DECODE_COVERAGE="$decoded" \
  node crates/conn-server/tools/replay.mjs "$release/examples/replay_server" "${scenarios[@]}"
run 4 120 "decode coverage" \
  node crates/conn-server/tools/decode-coverage.mjs "$decoded" "$release/conn-server"
run 4 120 "settings-diff" node crates/conn-server/tools/settings-diff.mjs "$release/conn-server"
# Settings secrets: the T3 server's own settings service and this server on one state folder.
run 4 120 "secrets-interop" node crates/conn-server/tools/secrets-interop.mjs "$release"
# Text generators and thread titles against T3's own code, on a loopback stub (no model).
run 4 120 "textgen-diff" node crates/conn-server/tools/textgen-diff.mjs "$release/examples/text_generation"
# GitHub and unknown-host fallback against T3's registry, test literals and a fixed grid.
run 4 120 "registry-diff" \
  node crates/conn-source-control/tools/registry-diff.mjs "$release/examples/registry_cases"
# Pull request watch evaluation and wake texts against T3's own pullRequestWatch.ts.
run 4 120 "pr-watch-diff" \
  node crates/conn-source-control/tools/pr-watch-diff.mjs "$release/examples/pr_watch_cases"
# Webhook prompt templates, filters and signatures against T3's own functions.
run 4 120 "webhook-diff" node crates/conn-features/tools/webhook-diff.mjs "$release/examples/webhook_functions"
run 4 120 "limits-diff" node crates/conn-server/tools/limits-diff.mjs
run 3 180 "parity" \
  node crates/conn-mcp/tools/parity.mjs "$release/examples/replay_server"
# Orbit's idle check: the shell route in 14 states on both servers, Codex on a stub (no model).
run 4 180 "idle-diff" node crates/conn-server/tools/idle-diff.mjs "$release/conn-server"
# Provider sign-in: every provider.auth.* reply and the CLI runs on both servers (stub CLIs).
run 4 180 "provider-auth-diff" node crates/conn-server/tools/provider-auth-diff.mjs "$release/conn-server"
run 2 120 "codex instructions --check" \
  node crates/conn-provider-codex/tools/gen-instructions.mjs --check
run 1 900 "codex conformance" node crates/conn-provider-codex/tools/conformance.mjs
run 2 120 "codex model catalog --check" node crates/conn-provider-codex/tools/gen-model-catalog.mjs --check
# Codex's status entry: T3's checkCodexProviderStatus and ours against stub CLIs (no CLI,
# no model; about 45 s, two scenarios wait out the 20 s probe limit).
run 3 180 "codex probe conformance" node crates/conn-provider-codex/tools/probe-conformance/run.mjs
run 3 120 "claude catalog --check" crates/conn-provider-claude/tools/gen-catalog/run.sh --check
# The Claude conformance check runs the real Agent SDK in the SDK host, so it needs
# `npm ci` in helpers/sdk-host. Without it the check is skipped, never counted as passed.
if [ "$group" != all ] && [ "$group" != 2 ]; then
  :
elif [ -d helpers/sdk-host/node_modules/@anthropic-ai/claude-agent-sdk ]; then
  run 2 240 "claude conformance" crates/conn-provider-claude/tools/conformance/run.sh
  # Claude's status entry: T3's checkClaudeProviderStatus and ours against stub CLIs.
  run 2 180 "claude probe conformance" node crates/conn-provider-claude/tools/probe-conformance/run.mjs
else
  printf '\nhelpers/sdk-host has no node_modules: skipping claude conformance (run npm ci in helpers/sdk-host).\n'
  skipped_tools+=("claude conformance" "claude probe conformance")
fi
# Exactly the scenarios in expected-failures.txt may fail; any other change fails the check.
run 2 180 "claude t3-replay" node crates/conn-provider-claude/tools/t3-replay/check.mjs
# T3's testkit fixtures through this engine and our providers, judged by T3's own
# assertions; exactly the variants in its expected-failures.txt may fail (about 10 min).
run 2 480 "t3 fixture replay" node crates/conn-engine/tools/t3-fixture-replay/check.mjs
# The T3 Grok adapter and conn-provider-acp against one stub agent (no agent, no model).
run 2 120 "acp instructions --check" node crates/conn-provider-acp/tools/gen-instructions.mjs --check
run 3 480 "acp conformance" node crates/conn-provider-acp/tools/conformance.mjs
# T3's Grok status probe and ours against one stub CLI per scenario (no CLI, no model).
run 2 180 "grok probe conformance" node crates/conn-provider-acp/tools/probe-conformance.mjs
# Orbit's task-turn commands (`t3 thread`, `t3 auth session`) on the T3 server with its own
# CLI and on this server with ours, one stub codex each (about 2 minutes).
run 4 300 "thread-cli-diff" node crates/conn-server/tools/thread-cli-diff.mjs "$release/conn-server"
# model-manifest.json: T3's encodeManifestCache against ours, on the bundled manifest.
run 4 120 "model-manifest-diff" \
  node crates/conn-server/tools/model-manifest-diff.mjs "$release/examples/model_manifest_cache"
# Hand runs are sealed: plain `cargo test` with a decoy outer environment, the way out, and
# the runner order (tools/sealed-run-check.mjs; needs no monorepo).
run rust 180 "sealed-run" node tools/sealed-run-check.mjs
# orbit-flow needs no monorepo.
run 2 120 "orbit-flow (fake provider)" \
  node crates/conn-server/tools/orbit-flow.mjs "$release/examples/replay_server"
# Claude and Codex instances from providerInstances, through the server, on recording stubs
# (no CLI, no model). Needs no monorepo; Claude runs through the SDK host.
if [ "$group" != all ] && [ "$group" != 3 ]; then
  :
elif [ -d helpers/sdk-host/node_modules/@anthropic-ai/claude-agent-sdk ]; then
  run 3 180 "instances-flow" node crates/conn-server/tools/instances-flow.mjs "$release/conn-server"
else
  printf '\nhelpers/sdk-host has no node_modules: skipping instances-flow (run npm ci in helpers/sdk-host).\n'
  skipped_tools+=("instances-flow")
fi

# The canary goes last: it reads what every check above left.
touch "$canary/stop"
wait "$canary_watch"
canary_watch=""
canary_check() {
  node tools/canary.mjs selftest && node tools/canary.mjs verify "$canary" "$canary_log" "$scratch"
}
run always 120 "canary" canary_check

printf '\n== Summary\n'
printf 'passed  %d\n' "${#passed[@]}"
for name in "${failed[@]+"${failed[@]}"}"; do printf 'FAILED  %s\n' "$name"; done
for name in "${skipped_tools[@]+"${skipped_tools[@]}"}"; do
  printf 'skipped %s (a tool or npm ci is missing; see above)\n' "$name"
  printf 'skip %s\n' "$name" >>"$summary"
done
[ "${#failed[@]}" -eq 0 ]
