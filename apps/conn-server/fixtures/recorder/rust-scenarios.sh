#!/usr/bin/env bash
# Runs the rust-* recorder scenarios: the real Conn web client against the Conn Server.
#
#   fixtures/recorder/rust-scenarios.sh fake [record.mjs options]   # no model call
#   fixtures/recorder/rust-scenarios.sh live [record.mjs options]   # Claude Haiku, 27 turns
#
# Needs the monorepo's web client built (`vp build` in apps/web, after `vp i` at the root),
# `cargo build --release -p conn-server --bins --examples`, and for `live` `npm ci` in
# helpers/sdk-host and a logged-in `claude`. Recordings go to a new temp folder unless
# `--out <dir>` is given; CONN_RECORDER_SHOTS=<dir> keeps the screenshots. Every server gets
# its own temp state folder. Exits 1 when a scenario fails.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# The server never fetches model-manifest.json from GitHub during a recording.
export CONN_MODEL_MANIFEST_URL=off
mode="${1:-}"
shift || true

# Both sets: scenarios the fake provider can drive (no tool runs, no prompts).
common=(
  rust-turn rust-restart rust-vcs rust-files rust-terminal rust-settings rust-search
  rust-worktree rust-worktree-files rust-review-added rust-secrets rust-archive
  rust-two-clients rust-follow-up rust-queue rust-model-switch
)
case "$mode" in
  fake)
    binary="$repo/target/release/examples/replay_server"
    # The fake provider runs no model: the switch is checked on the wire only.
    scenarios=("${common[@]}")
    ;;
  live)
    binary="$repo/target/release/conn-server"
    # Claude must act: a prompt, a tool call, an image, a subagent, an idle session close.
    scenarios=(
      "${common[@]}" rust-permission rust-stop-continue rust-mcp rust-attachment rust-subagent
      rust-memory
    )
    # rust-memory waits for the idle Claude session to close: one minute, not thirty.
    export CONN_SESSION_IDLE_TIMEOUT=1
    ;;
  *)
    sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
    exit 2
    ;;
esac

[ -x "$binary" ] || { echo "rust-scenarios: build $binary first" >&2; exit 2; }

out=()
case " $* " in
  *" --out "*) ;;
  *) out=(--out "$(mktemp -d "${TMPDIR:-/tmp}/conn-recordings.XXXXXX")") ;;
esac
exec node "$repo/fixtures/recorder/record.mjs" pairing "${scenarios[@]}" --rust "$binary" \
  "${out[@]+"${out[@]}"}" "$@"
