#!/usr/bin/env bash
# Conformance check: what the claude CLI receives from the T3 server's ClaudeAdapterV2 and from
# the Conn Server's Claude provider, for the same inputs. No model is called. See README.md.
#
#   ./run.sh [scenario...]
#
# Exit 0 when nothing differs beyond the listed normalizations; 1 otherwise. The report is
# printed and written to $OUT/report.txt.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
crate="$(cd "$here/../.." && pwd)"
workspace_root="$(cd "$crate/../.." && pwd)"
# The Conn monorepo root: the same tree, after `vp i` there.
repo="$(cd "$here/../../../../../.." && pwd)"
adapters="$repo/apps/server/src/orchestration-v2/Adapters"
# The copy's name carries this run's PID, so runs side by side on one checkout do not collide.
name="claudeConformance.$$.tmp.test.ts"
copy="$adapters/$name"
node_bin="$(dirname "$(command -v node)")"

[ -d "$adapters" ] || { echo "$repo has no apps/server Adapters directory" >&2; exit 1; }
[ -d "$workspace_root/helpers/sdk-host/node_modules" ] || {
  echo "run 'npm ci' in helpers/sdk-host first" >&2
  exit 1
}

OUT="${CONFORMANCE_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/conn-claude-conformance.XXXXXX")}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd -P)"
# Cargo reads ~/.gitconfig through HOME: it builds with a throwaway HOME of its own.
cargo_home="$OUT/cargo-home"
mkdir -p "$cargo_home"
cargo_env=(HOME="$cargo_home" CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}" RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1)
mkdir -p "$OUT/workspace" "$OUT/attachments" "$OUT/claude-home" "$OUT/home"
# The instance_launch_args scenario appends this file (one trailing newline is trimmed).
printf 'From the append file.\n\n' > "$OUT/home/append.txt"
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
  // A recording from testdata/cli, else a constructed one (constructed/README.md).
  const source = (name) =>
    [path.join(cli, name + ".ndjson"), path.join(path.dirname(stub), "constructed", name + ".ndjson")].find((p) => fs.existsSync(p));
  s.scripts.forEach((name, i) => fs.copyFileSync(source(name), path.join(dir, "scripts", i + ".ndjson")));
  // A start whose CLI never answers one control request (a CLI still booting).
  for (const [i, subtype] of Object.entries(s.hold ?? {})) fs.writeFileSync(path.join(dir, `hold-${i}`), subtype);
}' "$here/scenarios.json" "$OUT/$side" "$here/stub-claude" "$crate/testdata/cli"
}
prepare t3
prepare rust

# A stand-in login shell. Both servers read PATH, __MISE_DIFF and JAVA_HOME from the login
# shell at start (T3: fixPath in os-jank.ts; ours: conn_support::login_env::hydrate) and give
# them to the CLI. Its PATH has a blank entry, a repeat, and an entry the base PATH has too, so
# the merge rules (mergePathEntries) show; JAVA_HOME counts only when the base has none.
cat > "$OUT/login-shell" <<'SHELL'
#!/bin/sh
for name in PATH __MISE_DIFF JAVA_HOME; do
  printf '%s\n' "__T3CODE_ENV_${name}_START__"
  case "$name" in
    PATH) printf '%s\n' '/opt/login/bin: :/usr/bin:/opt/login/bin:/opt/login/tools' ;;
    __MISE_DIFF) printf '%s\n' 'mise-diff-from-login-shell' ;;
    JAVA_HOME) printf '%s\n' '/opt/login/java' ;;
  esac
  printf '%s\n' "__T3CODE_ENV_${name}_END__"
done
SHELL
chmod 755 "$OUT/login-shell"

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
  "SHELL=$OUT/login-shell"
)
# Under the canary (tools/check.sh), its Node hook and logs reach both sides alike.
if [ -n "${CONN_CANARY_ROOT:-}" ]; then
  base_env+=("NODE_OPTIONS=${NODE_OPTIONS:-}" "CONN_CANARY_ROOT=$CONN_CANARY_ROOT"
    "CONN_NETWORK_LOG=${CONN_NETWORK_LOG:-}" "CONN_CANARY_NODE_NETWORK_LOG=${CONN_CANARY_NODE_NETWORK_LOG:-}")
fi
if [ -n "${CONFORMANCE_BASE_JAVA_HOME:-}" ]; then
  base_env+=("JAVA_HOME=$CONFORMANCE_BASE_JAVA_HOME")
fi
printf '%s\n' "${base_env[@]}" > "$OUT/base.env"

if [ "${CONFORMANCE_SKIP_RUST:-}" != "1" ]; then
  echo "== Conn Server (helper)"
  binary="$(env "${cargo_env[@]}" CONN_CHECK_BINARIES="${CONN_CHECK_BINARIES:-}" node "$workspace_root/tools/check-binaries.mjs" conn-provider-claude conformance)"
  # The same working directory as the T3 side below: the spawn script's `cd -P` gives the CLI
  # OLDPWD, which is the spawning server's own working directory on both sides.
  (
    cd "$repo/apps/server"
    env -i "${base_env[@]}" \
      "$binary" \
      "$here/scenarios.json" "$OUT/rust" "$OUT/workspace" "$OUT/attachments" \
      "${CONFORMANCE_HELPER:-$workspace_root/helpers/sdk-host/index.mjs}" "$@"
  ) 2>&1 | tee "$OUT/rust.log"
fi

if [ "${CONFORMANCE_SKIP_T3:-}" != "1" ]; then
  echo "== T3 server (ClaudeAdapterV2)"
  trap 'rm -f "$copy"' EXIT
  # T3's code reaches no outside service: the guard is the file's first import.
  {
    printf 'import "%s";\n' "$(cd "$here/../../../.." && pwd)/tools/no-outside-fetch.mjs"
    cat "$here/claudeConformance.test.ts"
  } >"$copy"
  set +e
  (
    cd "$repo/apps/server"
    env -i "${base_env[@]}" \
      CONFORMANCE_SCENARIOS="$here/scenarios.json" CONFORMANCE_ROOT="$OUT/t3" \
      CONFORMANCE_WORKSPACE="$OUT/workspace" CONFORMANCE_ATTACHMENTS="$OUT/attachments" \
      CONFORMANCE_ONLY="$*" CONFORMANCE_BASE_ENV="$OUT/base.env" \
      "$node_bin/node" "$repo/node_modules/vite-plus/bin/vp" test run \
      "src/orchestration-v2/Adapters/$name"
  ) 2>&1 | tee "$OUT/t3.log"
  set -e
  rm -f "$copy"
  trap - EXIT
fi

node "$here/compare.mjs" "$OUT" "$@" | tee "$OUT/report.txt"
status="${PIPESTATUS[0]}"

# A full run also compares one turn with JAVA_HOME already set, where the login shell's value
# must not replace it.
if [ "$#" -eq 0 ] && [ -z "${CONFORMANCE_BASE_JAVA_HOME:-}" ]; then
  echo "== again with JAVA_HOME set in the server's environment"
  set +e
  CONFORMANCE_OUT="$OUT/java-home-set" CONFORMANCE_BASE_JAVA_HOME=/opt/server/java \
    "${BASH_SOURCE[0]}" fresh_turn
  nested=$?
  set -e
  [ "$nested" -eq 0 ] || status="$nested"
fi
exit "$status"
