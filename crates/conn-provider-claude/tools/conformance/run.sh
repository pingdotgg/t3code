#!/usr/bin/env bash
# Conformance check: what the claude CLI receives from the T3 server's ClaudeAdapterV2 and from
# the Conn Server's Claude provider, for the same inputs. No model is called. See README.md.
#
#   CONN_MONOREPO=/path/to/conn ./run.sh [scenario...]
#
# Exit 0 when nothing differs beyond the listed normalizations; 1 otherwise. The report is
# printed and written to $OUT/report.txt.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
crate="$(cd "$here/../.." && pwd)"
workspace_root="$(cd "$crate/../.." && pwd)"
repo="${CONN_MONOREPO:?set CONN_MONOREPO to a Conn monorepo checkout at conn.pin, after vp i}"
adapters="$repo/apps/server/src/orchestration-v2/Adapters"
copy="$adapters/claudeConformance.test.ts"
node_bin="$(dirname "$(command -v node)")"

[ -d "$adapters" ] || { echo "CONN_MONOREPO=$repo has no apps/server Adapters directory" >&2; exit 1; }
[ ! -e "$copy" ] || { echo "$copy already exists; refusing to overwrite it" >&2; exit 1; }
[ -d "$workspace_root/helpers/sdk-host/node_modules" ] || {
  echo "run 'npm ci' in helpers/sdk-host first" >&2
  exit 1
}

OUT="${CONFORMANCE_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/conn-claude-conformance.XXXXXX")}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd -P)"
mkdir -p "$OUT/workspace" "$OUT/attachments" "$OUT/claude-home" "$OUT/home"
echo "output: $OUT"

# The image of e15, as the attachment both sides send.
node -e '
const fs = require("fs");
for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean)) {
  const r = JSON.parse(l);
  const c = r.msg?.message?.content;
  if (r.dir === "out" && Array.isArray(c)) {
    const img = c.find((b) => b.type === "image");
    if (img) { fs.writeFileSync(process.argv[2], Buffer.from(img.source.data, "base64")); break; }
  }
}' "$crate/testdata/cli/e15_image.ndjson" "$OUT/attachments/attach-1.png"

# One stub directory per side and scenario, with the transcripts it replays.
prepare() {
  local side="$1"
  rm -rf "${OUT:?}/$side"
  node -e '
const fs = require("fs"), path = require("path");
const [scenarios, root, stub, cli] = process.argv.slice(1);
for (const s of JSON.parse(fs.readFileSync(scenarios, "utf8")).scenarios) {
  const dir = path.join(root, s.name);
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.copyFileSync(stub, path.join(dir, "stub-claude"));
  fs.chmodSync(path.join(dir, "stub-claude"), 0o755);
  s.scripts.forEach((name, i) => fs.copyFileSync(path.join(cli, name + ".ndjson"), path.join(dir, "scripts", i + ".ndjson")));
}' "$here/scenarios.json" "$OUT/$side" "$here/stub-claude" "$crate/testdata/cli"
}
prepare t3
prepare rust

# The same base environment for both runs. HOME is a throwaway, so neither side reads the
# user's Claude settings; CLAUDE_CONFIG_DIR points at an empty Claude home.
base_env=(
  "HOME=$OUT/home"
  "PATH=$node_bin:/usr/bin:/bin:/usr/sbin:/sbin"
  "USER=${USER:-conformance}"
  "LANG=en_US.UTF-8"
  "TMPDIR=$OUT"
  "CLAUDE_CONFIG_DIR=$OUT/claude-home"
  "CONFORMANCE_MARKER=1"
)
printf '%s\n' "${base_env[@]}" > "$OUT/base.env"

if [ "${CONFORMANCE_SKIP_RUST:-}" != "1" ]; then
  echo "== Conn Server (helper)"
  (cd "$workspace_root" && cargo build -q -p conn-provider-claude --example conformance)
  # The same working directory as the T3 side below: the spawn script's `cd -P` gives the CLI
  # OLDPWD, which is the spawning server's own working directory on both sides.
  (
    cd "$repo/apps/server"
    env -i "${base_env[@]}" \
      "$workspace_root/target/debug/examples/conformance" \
      "$here/scenarios.json" "$OUT/rust" "$OUT/workspace" "$OUT/attachments" \
      "${CONFORMANCE_HELPER:-$workspace_root/helpers/sdk-host/index.mjs}" "$@"
  ) 2>&1 | tee "$OUT/rust.log"
fi

if [ "${CONFORMANCE_SKIP_T3:-}" != "1" ]; then
  echo "== T3 server (ClaudeAdapterV2)"
  trap 'rm -f "$copy"' EXIT
  cp "$here/claudeConformance.test.ts" "$copy"
  set +e
  (
    cd "$repo/apps/server"
    env -i "${base_env[@]}" \
      CONFORMANCE_SCENARIOS="$here/scenarios.json" CONFORMANCE_ROOT="$OUT/t3" \
      CONFORMANCE_WORKSPACE="$OUT/workspace" CONFORMANCE_ATTACHMENTS="$OUT/attachments" \
      CONFORMANCE_ONLY="$*" CONFORMANCE_BASE_ENV="$OUT/base.env" \
      "$node_bin/node" "$repo/node_modules/vite-plus/bin/vp" test run \
      src/orchestration-v2/Adapters/claudeConformance.test.ts
  ) 2>&1 | tee "$OUT/t3.log"
  set -e
  rm -f "$copy"
  trap - EXIT
fi

node "$here/compare.mjs" "$OUT" "$@" | tee "$OUT/report.txt"
exit "${PIPESTATUS[0]}"
