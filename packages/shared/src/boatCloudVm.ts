/**
 * What runs on Boat cloud VMs, and how a holder picks one. Boat VMs are Ubuntu
 * with systemd user services, git, Node and sqlite3, and the agent CLIs.
 */

const VM_HOME = "/home/user";
const USERDATA_DB = `${VM_HOME}/.t3/userdata/statev2.sqlite`;
export const VM_T3_PORT = 3773;
export const VM_SKILLS_ARCHIVE = "/tmp/t3-skills.tar.gz";
export const VM_BACKUP_ARCHIVE = "/tmp/t3-boat-backup.tar.gz";
export const MACHINE_LABELS = { t3code: "cloud" } as const;
export const MACHINE_LABEL_FILTER = "t3code=cloud";
export const SETUP_LABELS = { t3code: "setup" } as const;
export const SETUP_LABEL_FILTER = "t3code=setup";
/**
 * Boat stops a VM this long after its deadline was last moved. The VM moves it
 * itself while any of its threads runs a turn, so a quiet VM stops with no holder online.
 */
export const IDLE_TTL_SECONDS = 10 * 60;

/** Every thread VM's name. Labels are fixed at create, so a spare is told apart by its name. */
export const MACHINE_NAME = "Boat cloud";
/**
 * One running VM, the smallest size, kept ready from the snapshot with its server up so a
 * start skips the boot. A start takes it by renaming it; it grows on its first resume.
 */
export const SPARE_NAME = "Boat cloud spare";
/** Boat stops a spare no client has asked for in this long; its disk stays for the next resume. */
export const SPARE_TTL_SECONDS = 30 * 60;
/** Names the snapshot a VM started from, so a spare from an older one is replaced. */
export const SNAPSHOT_LABEL = "t3code-snapshot";

const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// Releases up to 0.1.9 leave Node's compile cache off in the single executable, which doubles
// every `t3` start, so the scripts and the server turn it on themselves.
const COMPILE_CACHE = `${VM_HOME}/.cache/t3code/compile-cache`;
const COMPILE_CACHE_DROP_IN = `[Service]
Environment=NODE_COMPILE_CACHE=${COMPILE_CACHE}`;

// `t3 update` can install a newer runtime, so prefer the newest one, then one on PATH.
const T3 = `export NODE_COMPILE_CACHE=${COMPILE_CACHE}; T3="$(ls -1d ${VM_HOME}/.t3/runtime/versions/*/t3 2>/dev/null | sort -V | tail -n1)"; [ -x "$T3" ] || T3="$(command -v t3 || true)"; [ -n "$T3" ] || { echo "T3 Code is not installed on this VM." >&2; exit 1; }`;

/**
 * VMs run this fork's own t3 builds, not the npm release, so they carry the fork's
 * changes. `.github/workflows/boat-cloud-cli.yml` publishes each one as a GitHub release.
 */
export const CLI_RELEASE_REPOSITORY = "vkpdeveloper/t3code";
const CLI_RELEASE_TAG_PREFIX = "boat-cli-v";
const EXACT_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

/** The t3 version a release tag carries, or null for a tag that is not a Boat cloud build. */
export const cliVersionOfTag = (tag: string) => {
  if (!tag.startsWith(CLI_RELEASE_TAG_PREFIX)) return null;
  const version = tag.slice(CLI_RELEASE_TAG_PREFIX.length);
  return EXACT_VERSION.test(version) ? version : null;
};

const SNAPSHOT_PREFIX = "t3-code";

/**
 * Boat keeps nothing else a holder can read about a snapshot, so its name records the
 * t3 build and whether a machine's skills are in it. Names allow lowercase letters,
 * digits and dashes; plain `t3-code` is from before builds were named.
 */
export const snapshotNameOf = (version: string, withSkills: boolean) =>
  `${SNAPSHOT_PREFIX}-${version.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-")}${withSkills ? "-skills" : ""}`;

export const isBoatCloudSnapshot = (name: string) =>
  name === SNAPSHOT_PREFIX || name.startsWith(`${SNAPSHOT_PREFIX}-`);

/** Installs that build into the runtime layout `t3 service install` expects, checksum first. */
export const installCliScript = (version: string) => {
  const base = `https://github.com/${CLI_RELEASE_REPOSITORY}/releases/download/${CLI_RELEASE_TAG_PREFIX}${version}`;
  const archive = `t3-${version}-linux-x64.tar.gz`;
  return `set -eu
[ "$(uname -m)" = x86_64 ] || { echo "Boat cloud builds of t3 are x86_64 only." >&2; exit 1; }
dir=${VM_HOME}/.t3/runtime/versions/${q(version)}
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 3 --max-time 120 ${q(`${base}/SHA256SUMS`)} -o "$tmp/SHA256SUMS"
curl -fsSL --retry 3 --max-time 600 ${q(`${base}/${archive}`)} -o "$tmp/${archive}"
(cd "$tmp" && grep -F ${q(archive)} SHA256SUMS | sha256sum -c --status -)
rm -rf "$dir" && mkdir -p "$dir"
tar -xzf "$tmp/${archive}" -C "$dir" --strip-components=1
"$dir/t3" --version
printf '%s\\n' ${q(version)} > "$dir/.install-complete"
"$dir/t3" service install`;
};

export const extractSkillsScript = `set -e
tar -xzf ${VM_SKILLS_ARCHIVE} -C ${VM_HOME}
rm -f ${VM_SKILLS_ARCHIVE}`;

const ACTIVE_RUN_STATUSES = "'preparing','queued','starting','running','waiting'";
const ACTIVE_RUNS_QUERY = `db=${USERDATA_DB}
[ -f "$db" ] || { echo 0; exit 0; }
sqlite3 -readonly "$db" "SELECT count(*) FROM orchestration_v2_projection_runs WHERE status IN (${ACTIVE_RUN_STATUSES})"`;

/** Epoch seconds of the last time the VM saw a running turn. */
const LAST_ACTIVE_PATH = `${VM_HOME}/.t3-boat-last-active`;
const READ_ACTIVE = `active="$( { ${ACTIVE_RUNS_QUERY.replaceAll("\n", "; ")} ; } 2>/dev/null )"
[ "\${active:-0}" -gt 0 ] 2>/dev/null && date +%s > ${LAST_ACTIVE_PATH}`;

/**
 * Prints `<active runs> <seconds since a turn last ran>`, the second empty when
 * no turn ever ran. The VM's own clock measures it, so holder clock skew does not matter.
 */
export const idleScript = `${READ_ACTIVE}
last="$(cat ${LAST_ACTIVE_PATH} 2>/dev/null)"
printf '%s %s\\n' "\${active:-0}" "\${last:+$(( $(date +%s) - last ))}"`;

const KEEPALIVE_PATH = `${VM_HOME}/.t3-boat-keepalive.sh`;
const UNIT_DIRECTORY = `${VM_HOME}/.config/systemd/user`;
const KEEPALIVE_SCRIPT = `#!/bin/sh
${READ_ACTIVE} && boat extend "$BOAT_ID" --ttl ${IDLE_TTL_SECONDS} >/dev/null 2>&1
exit 0`;
const KEEPALIVE_SERVICE = `[Unit]
Description=Keep this Boat VM on while T3 Code runs a turn
[Service]
Type=oneshot
# A login shell carries BOAT_ID and the boat CLI's PATH.
ExecStart=/bin/bash -lc ${KEEPALIVE_PATH}`;
const KEEPALIVE_TIMER = `[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target`;

/**
 * Boat keeps a hosted port until the VM boots again, and routes it only once the server
 * listens. The VM hosts its own port after every boot, so a holder never asks Boat to.
 * The stamp names the VM and its boot, so one copied in from a snapshot does not count.
 */
const HOSTED_STAMP = `${VM_HOME}/.t3-boat-hosted`;
const HOST_PATH = `${VM_HOME}/.t3-boat-host.sh`;
const HOST_SCRIPT = `#!/bin/sh
stamp="$BOAT_ID $(cat /proc/sys/kernel/random/boot_id)"
[ "$(cat ${HOSTED_STAMP} 2>/dev/null)" = "$stamp" ] && exit 0
for i in $(seq 1 600); do
  curl -sf -o /dev/null --max-time 2 http://127.0.0.1:${VM_T3_PORT}/.well-known/t3/environment && break
  sleep 0.1
done
boat host "$BOAT_ID" ${VM_T3_PORT} --public --localhost >/dev/null && printf '%s\\n' "$stamp" > ${HOSTED_STAMP}`;
const HOST_SERVICE = `[Unit]
Description=Serve T3 Code on this Boat VM's URL
After=t3code.service
[Service]
Type=oneshot
TimeoutStartSec=60
ExecStart=/bin/bash -lc ${HOST_PATH}
[Install]
WantedBy=t3code.service`;

const INSTRUCTIONS_MARKER = "t3-boat-cloud";
const AGENT_INSTRUCTIONS = `This is a Boat cloud VM. When you finish a task, commit your changes with a clear message and push the branch to origin. Do not open a pull request unless the user asks for one.`;

/**
 * Makes a VM keep itself on during turns and tells its agents to commit and
 * push. Idempotent, so it also brings VMs from an older snapshot up to date.
 */
const prepareVmScript = `set -e
changed=""
put() { [ "$(cat "$1" 2>/dev/null)" = "$2" ] || { printf '%s\\n' "$2" > "$1"; changed=1; }; }
mkdir -p ${UNIT_DIRECTORY}
put ${KEEPALIVE_PATH} ${q(KEEPALIVE_SCRIPT)}
chmod +x ${KEEPALIVE_PATH}
put ${UNIT_DIRECTORY}/t3-boat-keepalive.service ${q(KEEPALIVE_SERVICE)}
put ${UNIT_DIRECTORY}/t3-boat-keepalive.timer ${q(KEEPALIVE_TIMER)}
put ${HOST_PATH} ${q(HOST_SCRIPT)}
chmod +x ${HOST_PATH}
put ${UNIT_DIRECTORY}/t3-boat-host.service ${q(HOST_SERVICE)}
mkdir -p ${UNIT_DIRECTORY}/t3code.service.d
put ${UNIT_DIRECTORY}/t3code.service.d/boat-compile-cache.conf ${q(COMPILE_CACHE_DROP_IN)}
if [ -n "$changed" ]; then
  systemctl --user daemon-reload
  systemctl --user enable t3-boat-keepalive.timer >/dev/null 2>&1 || true
  systemctl --user restart t3-boat-keepalive.timer >/dev/null 2>&1 || true
  systemctl --user enable t3-boat-host.service >/dev/null 2>&1 || true
fi
for f in ${VM_HOME}/.claude/CLAUDE.md ${VM_HOME}/.codex/AGENTS.md; do
  mkdir -p "$(dirname "$f")"
  grep -qs ${INSTRUCTIONS_MARKER} "$f" || printf '\\n<!-- ${INSTRUCTIONS_MARKER} -->\\n%s\\n' ${q(AGENT_INSTRUCTIONS)} >> "$f"
done`;

/**
 * Leaves the snapshot without T3 state, so every VM made from it gets its own
 * environment id. The logs directory stays because the service unit appends to it.
 */
export const prepareSnapshotScript = `set -e
${prepareVmScript}
systemctl --user stop t3code.service
find ${VM_HOME}/.t3/userdata -mindepth 1 -maxdepth 1 ! -name logs -exec rm -rf {} +
rm -rf ${VM_HOME}/.t3/userdata/logs/* ${VM_HOME}/.t3/usage-host-id ${HOSTED_STAMP}
# Fills the compile cache, so the first server start on a new VM already uses it.
${T3}
"$T3" --version >/dev/null
sync`;

/** What Boat's Agents & Proxying page and GitHub connection give a VM. */
const BOAT_CREDENTIALS = [
  "ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY OPENAI_BASE_URL CHATGPT_ACCOUNT_ID OPENCODE_API_KEY OPENROUTER_API_KEY",
  "LLMGATEWAY_API_KEY MISTRAL_API_KEY XAI_API_KEY DEEPSEEK_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK AWS_BEARER_TOKEN_BEDROCK AWS_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY",
  "GH_TOKEN GITHUB_TOKEN",
].join(" ");

/**
 * The agents on a VM that each of Boat's AI credentials signs in, by provider driver.
 * Boat's VMs come with these CLIs, and each reads the variables its credential sets.
 */
const PROVIDER_CREDENTIALS: Readonly<Record<string, ReadonlyArray<string>>> = {
  claudeAgent: ["anthropic-api-key", "claude-subscription", "claude-bedrock"],
  codex: ["openai-api-key", "chatgpt-subscription", "codex-bedrock"],
  ...Object.fromEntries(
    ["opencode", "pi"].map((driver) => [
      driver,
      [
        "anthropic-api-key",
        "openai-api-key",
        "openrouter-api-key",
        "llmgateway-api-key",
        "mistral-api-key",
        "xai-api-key",
        "grok-subscription",
        "opencode-api-key",
      ],
    ]),
  ),
};

/** The provider drivers a VM with these Boat credentials can run. */
export function boatCloudProviderDrivers(credentials: ReadonlyArray<string>): Set<string> {
  return new Set(
    Object.entries(PROVIDER_CREDENTIALS)
      .filter(([, signIns]) => signIns.some((signIn) => credentials.includes(signIn)))
      .map(([driver]) => driver),
  );
}
const CREDENTIALS_STAMP = '"${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/t3-boat-credentials"';

/**
 * Boat sets its credentials only in the commands it runs, never in systemd services, so
 * the server gets them here. It restarts only when they changed and no turn would be cut.
 * The stamp lives in the runtime dir, which a reboot clears along with the imported values.
 * Already a few milliseconds when nothing changed, so every start runs it.
 */
const syncCredentialsScript = `names=${q(BOAT_CREDENTIALS)}
set_names=""
for n in $names; do eval "[ -n \\"\\\${$n-}\\" ]" && set_names="$set_names $n"; done
stamp="$(for n in $set_names; do eval "printf '%s=%s\\n' $n \\"\\\${$n}\\""; done | sha256sum | cut -c1-64)"
if [ "$stamp" != "$(cat ${CREDENTIALS_STAMP} 2>/dev/null)" ] && [ "$( { ${ACTIVE_RUNS_QUERY.replaceAll("\n", "; ")} ; } 2>/dev/null )" = 0 ]; then
  systemctl --user unset-environment $names
  [ -z "$set_names" ] || systemctl --user import-environment $set_names
  printf '%s' "$stamp" > ${CREDENTIALS_STAMP}
  systemctl --user try-restart t3code.service >/dev/null 2>&1 || true
fi`;

/** Leaves the server's descriptor in `$out` once it answers, polling often since every start waits on it. */
const WAIT_SERVER_SCRIPT = `up=""
for i in $(seq 1 600); do
  out="$(curl -sf --max-time 2 http://127.0.0.1:${VM_T3_PORT}/.well-known/t3/environment)" && { up=1; break; }
  sleep 0.1
done
[ -n "$up" ] || { echo "T3 Code did not start on this VM." >&2; exit 1; }`;

/** Opens `startServerScript` output when the VM could not host its own port, so the holder does. */
export const NOT_HOSTED_MARKER = "--- t3 not hosted ---";

/**
 * Prepares the VM, starts the server and prints its descriptor once it answers and its port
 * is hosted. Hosting takes a few milliseconds once done since boot.
 */
const ensureServerScript = `( set -e
${prepareVmScript}
) >&2 || { echo "Could not prepare this VM." >&2; exit 1; }
${syncCredentialsScript}
systemctl --user start t3code.service >/dev/null 2>&1 || true
${WAIT_SERVER_SCRIPT}
systemctl --user start t3-boat-host.service >/dev/null 2>&1 || echo ${q(NOT_HOSTED_MARKER)}
# A hand-out counts as activity, so every holder's idle sweep, not only this one's, leaves the VM on.
date +%s > ${LAST_ACTIVE_PATH}
printf '%s\\n' "$out"`;

/** Separates the descriptor from the pairing code in `startServerScript` output. */
export const PAIRING_MARKER = "--- t3 pairing ---";

const pairCommand = (label: string, ttl = "10m") =>
  `"$T3" auth pairing create --json --ttl ${ttl} --label ${q(label)}`;

/** Mints a pairing code on a running server. */
export const pairScript = (label: string) => `${T3}
${pairCommand(label)}`;

/**
 * A single-use pairing code minted ahead on a spare, as `auth pairing create --json` output,
 * so a start skips the T3 CLI. It lives on the VM since any holder may take the spare.
 */
const PAIRING_STOCK = `${VM_HOME}/.t3-boat-pairing.json`;

/**
 * `stock_valid <file> <minutes>`: the server's own database still holds the file's code
 * unused, unrevoked and valid that much longer. A reset or restored state fails it too.
 */
const STOCK_VALID_FUNCTION = `stock_valid() {
  local id
  id="$(grep -o '"id": *"[0-9A-Za-z-]*"' "$1" 2>/dev/null | head -n1 | cut -d'"' -f4)"
  [ -n "$id" ] && [ "$(sqlite3 -readonly ${USERDATA_DB} "SELECT count(*) FROM auth_pairing_links WHERE id = '$id' AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+$2 minutes')" 2>/dev/null)" = 1 ]
}`;

/**
 * Leaves a fresh code in `PAIRING_STOCK`, in the background so it returns at once. It
 * outlives the spare's TTL, and is replaced once a client looking finds less than that left.
 */
export const stockPairingScript = (label: string) => `${T3}
${STOCK_VALID_FUNCTION}
(
  exec 9>/tmp/t3-boat-pairing.lock
  flock -n 9 || exit 0
  stock_valid ${PAIRING_STOCK} ${SPARE_TTL_SECONDS / 60} && exit 0
  umask 077
  ${pairCommand(label, "60m")} > ${PAIRING_STOCK}.new && mv ${PAIRING_STOCK}.new ${PAIRING_STOCK}
) </dev/null >/dev/null 2>&1 &`;

/**
 * `ensureServerScript`, then a pairing code after `PAIRING_MARKER` when a label is given,
 * so a start needs one command on the VM. The code stays valid at least `minutes`. It takes
 * the stocked code when that holds, moving it away first so no two starts get the same one.
 */
export const startServerScript = (pairingLabel: string | null, minutes = 10) =>
  pairingLabel === null
    ? ensureServerScript
    : `${ensureServerScript}
${STOCK_VALID_FUNCTION}
taken=${PAIRING_STOCK}.$$
if mv ${PAIRING_STOCK} "$taken" 2>/dev/null && stock_valid "$taken" ${minutes}; then
  echo ${q(PAIRING_MARKER)}
  cat "$taken"
  rm -f "$taken"
else
  rm -f "$taken"
  ${T3}
  echo ${q(PAIRING_MARKER)}
  ${pairCommand(pairingLabel, minutes > 10 ? "60m" : "10m")}
fi`;

/**
 * First line `cpu memTotalKb memAvailableKb`, then the workspace root when the VM has it
 * checked out. Searching ~/projects instead took seconds on old layouts. `cpu` is the share
 * of the last 10 seconds that tasks waited for a CPU. The load average also counts tasks
 * waiting on Boat's lazily fetched disk, so a just-resumed idle VM read as busy for a minute.
 */
export const measureScript = (workspaceRoot: string) =>
  `cpu="$(awk '/^some /{sub("avg10=", "", $2); print $2 / 100}' /proc/pressure/cpu 2>/dev/null)"
[ -n "$cpu" ] || cpu="$(awk -v cpus="$(nproc)" '{print $1 / cpus}' /proc/loadavg)"
printf '%s %s %s\\n' "$cpu" "$(awk '/^MemTotal:/{print $2}' /proc/meminfo)" "$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)"
[ ! -d ${q(`${workspaceRoot}/.git`)} ] || printf '%s\\n' ${q(workspaceRoot)}`;

export const BASE_BRANCH_MISSING_EXIT = 3;

/**
 * Fails, naming the branch, when the clone in `$dir` has no remote copy of it.
 * The clone has none of the client's local branches, so a thread can only
 * start from one that was pushed.
 */
const hasBaseBranch = (baseBranch: string) => {
  const has = (ref: string) =>
    `git -C "$dir" rev-parse --verify --quiet ${q(`${ref}^{commit}`)} >/dev/null`;
  return `{ ${has(`refs/remotes/origin/${baseBranch}`)} || ${has(`refs/remotes/${baseBranch}`)}; }`;
};

export const baseBranchCheckScript = (baseBranch: string, repositoryName: string) =>
  `if ! ${hasBaseBranch(baseBranch)}; then
  echo ${q(`${baseBranch} is not on ${repositoryName}. Push it, or start from a pushed branch.`)} >&2
  exit ${BASE_BRANCH_MISSING_EXIT}
fi`;

/**
 * Clones the repository once. An existing checkout is fetched only when it does
 * not know the base branch: a worktree thread fetches its base itself.
 * A checkout from the snapshot sits on Boat's lazily fetched disk, so its packs are read
 * ahead while the server starts: a worktree add that read them cold took 17 seconds.
 */
export const syncCheckoutScript = (
  repository: ParsedRepository,
  baseBranch: string | null,
) => `set -e
dir=${q(repository.workspaceRoot)}
if [ -d "$dir/.git" ]; then
  ( cat "$dir"/.git/objects/pack/*.pack "$dir/.git/index" ) </dev/null >/dev/null 2>&1 &
  ${baseBranch === null ? ":" : `${hasBaseBranch(baseBranch)} || git -C "$dir" fetch --prune --quiet origin`}
else
  mkdir -p "$(dirname "$dir")"
  git clone --quiet ${q(repository.cloneUrl)} "$dir"
fi
${baseBranch === null ? "" : baseBranchCheckScript(baseBranch, repository.name)}`;

/** Seconds each snapshot clone may take; Boat ends a command after 300. */
const SNAPSHOT_CLONE_SECONDS = 270;

/**
 * Clones the repositories at once, for the snapshot. A clone that fails or runs out of
 * time leaves nothing behind, so a VM clones that repository on first use instead.
 * Prints each workspace root it cloned.
 */
export const cloneRepositoriesScript = (repositories: ReadonlyArray<ParsedRepository>) =>
  `clone() {
  mkdir -p "$(dirname "$1")"
  if GIT_TERMINAL_PROMPT=0 timeout ${SNAPSHOT_CLONE_SECONDS} git clone --quiet "$2" "$1.cloning" </dev/null >/dev/null 2>&1; then
    mv "$1.cloning" "$1" && printf '%s\\n' "$1"
  else
    rm -rf "$1.cloning"
  fi
}
${repositories.map((repository) => `clone ${q(repository.workspaceRoot)} ${q(repository.cloneUrl)} &`).join("\n")}
wait`;

/** A thread's worktree, made on the VM while its server starts. */
export interface PreparedWorktree {
  readonly path: string;
  readonly branch: string;
  readonly baseBranch: string;
}

/** Where a VM keeps a worktree for `branch`, under the T3 home the backup copies. */
export const worktreePathOf = (repository: ParsedRepository, branch: string) =>
  `${VM_HOME}/.t3/worktrees/${repository.key.split("/").at(-1)!.replace(SAFE_SEGMENT, "-")}/${branch.replaceAll("/", "-")}`;

/**
 * A worktree per checkout, kept on its default branch while the VM waits, so a thread moves
 * one into place rather than checking out every file (1 to 5 seconds on Boat's lazy disk).
 * It lives outside the T3 home and the projects, so backups leave it out.
 */
const PARKED_ROOT = `${VM_HOME}/.t3-boat-parked`;
const PARKED_BRANCH = "t3code/boat-parked";
/** Set once the parked checkout finishes, so a half-made one is never taken. */
const PARKED_BASE_KEY = `branch.${PARKED_BRANCH}.t3-boat-parked-base`;

const parkedPathOf = (workspaceRoot: string) =>
  `${PARKED_ROOT}/${workspaceRoot.slice(`${VM_HOME}/projects/`.length)}`;

/** `park_checkout <checkout> <parked path>`: parks a worktree on the default branch, or updates the parked one. */
export const parkCheckoutFunction = `park_checkout() {
  local dir="$1" parked="$2" base start
  base="$(git -C "$dir" symbolic-ref --quiet --short refs/remotes/origin/HEAD)" || return 0
  base="\${base#origin/}"
  git -C "$dir" fetch --quiet origin "$base" || true
  start="refs/remotes/origin/$base"
  if [ -e "$parked/.git" ] && [ "$(git -C "$dir" config --get ${PARKED_BASE_KEY})" = "$base" ]; then
    [ "$(git -C "$parked" rev-parse HEAD)" != "$(git -C "$dir" rev-parse "$start")" ] || return 0
    git -C "$dir" config --unset ${PARKED_BASE_KEY}
    git -C "$parked" reset --quiet --keep "$start" && git -C "$dir" config ${PARKED_BASE_KEY} "$base"
    return 0
  fi
  rm -rf "$parked"
  git -C "$dir" worktree prune
  git -C "$dir" branch --force --no-track ${PARKED_BRANCH} "$start" &&
    mkdir -p "$(dirname "$parked")" &&
    git -C "$dir" -c checkout.workers=0 worktree add --quiet "$parked" ${PARKED_BRANCH} &&
    git -C "$dir" config ${PARKED_BASE_KEY} "$base"
}`;

/**
 * Cuts the thread's branch from the remote base, the way T3 does for a worktree that
 * starts from origin, recording the base as T3 does so diffs and pull requests use it.
 * A worktree parked on that base is renamed into place and moved to the latest base.
 */
export const prepareWorktreeScript = (worktree: PreparedWorktree, parkedPath: string) => {
  const branch = q(worktree.branch);
  const path = q(worktree.path);
  return `git -C "$dir" fetch --quiet origin ${q(worktree.baseBranch)} || true
start=${q(`refs/remotes/origin/${worktree.baseBranch}`)}
git -C "$dir" rev-parse --verify --quiet "$start^{commit}" >/dev/null || start=${q(`refs/remotes/${worktree.baseBranch}`)}
mkdir -p "$(dirname ${path})"
if [ -e ${q(`${parkedPath}/.git`)} ] && [ "$(git -C "$dir" config --get ${PARKED_BASE_KEY})" = ${q(worktree.baseBranch)} ] &&
  git -C "$dir" worktree move ${q(parkedPath)} ${path} 2>/dev/null; then
  git -C "$dir" branch -m ${PARKED_BRANCH} ${branch}
  git -C "$dir" config --unset ${q(`branch.${worktree.branch}.t3-boat-parked-base`)} || true
  [ "$(git -C ${path} rev-parse HEAD)" = "$(git -C "$dir" rev-parse "$start^{commit}")" ] ||
    git -C ${path} reset --quiet --keep "$start"
else
  git -C "$dir" branch --no-track ${branch} "$start"
  git -C "$dir" -c checkout.workers=0 worktree add --quiet ${path} ${branch}
fi
git -C "$dir" config ${q(`branch.${worktree.branch}.t3-merge-base`)} ${q(worktree.baseBranch)}
git -C "$dir" config ${q(`branch.${worktree.branch}.t3-merge-base-ref`)} "$start"`;
};

/** Adds the checkout in `$dir` as a project unless it is one, which skips starting the CLI. */
// A new VM has no database until its server starts, and the checkout runs under `set -e`.
export const ADD_PROJECT_SCRIPT = `known="$(sqlite3 -readonly ${USERDATA_DB} "SELECT count(*) FROM projection_projects WHERE workspace_root = '$dir' AND deleted_at IS NULL AND archived_at IS NULL" 2>/dev/null || true)"
if [ "\${known:-0}" = 0 ]; then
  ${WAIT_SERVER_SCRIPT.replaceAll("\n", "\n  ")}
  "$T3" project add "$dir" >/dev/null 2>&1 || true
fi`;

/**
 * Gets the checkout and the thread's worktree, then adds the checkout as a project once the
 * server answers. Runs while the server starts, or alone on a ready spare, so it marks the
 * hand-out as activity too.
 */
export const checkoutScript = (
  repository: ParsedRepository,
  baseBranch: string | null,
  worktree: PreparedWorktree | null = null,
) =>
  `date +%s > ${LAST_ACTIVE_PATH}
${syncCheckoutScript(repository, baseBranch)}
${worktree === null ? "" : prepareWorktreeScript(worktree, parkedPathOf(repository.workspaceRoot))}
${T3}
${ADD_PROJECT_SCRIPT}`;

/**
 * For the spare, in the background so it returns at once: fetches each checkout's default
 * branch, parks a worktree on it, adds it as a project, and reads its packs so Boat's lazily
 * fetched disk holds them. One run at a time; a run already going is enough.
 */
export const parkWorktreesScript = `${T3}
${parkCheckoutFunction}
(
  exec 9>/tmp/t3-boat-park.lock
  flock -n 9 || exit 0
  find ${VM_HOME}/projects -maxdepth 6 -type d -name .git -prune 2>/dev/null | while read -r git; do
    dir="\${git%/.git}"
    park_checkout "$dir" "${PARKED_ROOT}/\${dir#${VM_HOME}/projects/}"
    ${ADD_PROJECT_SCRIPT.replaceAll("\n", "\n    ")}
    cat "$git"/objects/pack/*.pack "$git/index"
  done
) </dev/null >/dev/null 2>&1 &`;

const BACKUP_PATHS = [
  ".t3/userdata",
  ".t3/worktrees",
  ".claude/projects",
  ".codex/sessions",
  "projects",
];

/**
 * Stops the server so its database is consistent, then archives what a fresh
 * VM needs to continue: T3 state, provider sessions and workspaces.
 */
export const backupScript = `set -e
cd ${VM_HOME}
systemctl --user stop t3code.service || true
paths=""
for p in ${BACKUP_PATHS.join(" ")}; do [ -e "$p" ] && paths="$paths $p"; done
tar -czf ${VM_BACKUP_ARCHIVE} --exclude=node_modules --exclude=.t3/userdata/logs $paths`;

export const restoreScript = `set -e
systemctl --user stop t3code.service
find ${VM_HOME}/.t3/userdata -mindepth 1 -maxdepth 1 ! -name logs -exec rm -rf {} +
tar -xzf ${VM_BACKUP_ARCHIVE} -C ${VM_HOME}
rm -f ${VM_BACKUP_ARCHIVE}
systemctl --user start t3code.service`;

/** A display name from the sandbox id, the same on every holder. */
export const machineLabelOf = (sandboxId: string) => `Boat cloud ${sandboxId.slice(-4)}`;

/** The VM a hosted T3 URL belongs to: `https://<subdomain>-3773.on.boat.dev`. */
export function subdomainOfHttpBaseUrl(httpBaseUrl: string): string | null {
  try {
    const host = new URL(httpBaseUrl).hostname;
    const suffix = `-${VM_T3_PORT}.on.boat.dev`;
    return host.endsWith(suffix) ? host.slice(0, -suffix.length) : null;
  } catch {
    return null;
  }
}

/** A VM above this share of CPU waiting or memory use gets no new sessions. */
const MAX_SHARED_USAGE = 0.5;

export interface ParsedRepository {
  /** Lowercase `host/owner/repo`, the same for every remote form of one repository. Owner may nest. */
  readonly key: string;
  /** `owner/repo`, for display. */
  readonly name: string;
  readonly cloneUrl: string;
  /** `~/projects/<key>`, so no two repositories share a checkout. */
  readonly workspaceRoot: string;
}

const SCP_REMOTE = /^(?:[^@/]+@)?([^:/]+):(.+)$/u;
const SAFE_SEGMENT = /[^A-Za-z0-9._-]/gu;

/**
 * VMs clone over HTTPS, which Boat's GitHub integration authorizes, so SSH
 * remotes become their HTTPS form.
 */
export function parseRepository(remoteUrl: string): ParsedRepository | null {
  const trimmed = remoteUrl.trim();
  let host: string;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return null;
    host = url.hostname;
    path = url.pathname;
  } else {
    const match = SCP_REMOTE.exec(trimmed);
    if (!match) return null;
    host = match[1]!;
    path = match[2]!;
  }
  const segments = path
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "")
    .split("/")
    .filter((segment) => segment.length > 0);
  if (!host || segments.length < 2) return null;
  const repo = segments.at(-1)!;
  const owner = segments.slice(0, -1).join("/");
  const key = `${host}/${owner}/${repo}`.toLowerCase();
  return {
    key,
    name: `${owner}/${repo}`,
    cloneUrl: `https://${host}/${owner}/${repo}.git`,
    workspaceRoot: `${VM_HOME}/projects/${key
      .split("/")
      .map((segment) => segment.replace(SAFE_SEGMENT, "-"))
      .join("/")}`,
  };
}

export interface MachineMeasure {
  /** The larger of CPU waiting and memory use, 0 to 1. */
  readonly usage: number;
  /** Checkout directories on the VM. */
  readonly workspaceRoots: ReadonlyArray<string>;
}

/** Reads `measureScript` output. */
export function parseMeasure(output: string): MachineMeasure | null {
  const [first = "", ...rest] = output.trim().split("\n");
  const [cpu, memTotal, memAvailable] = first.trim().split(/\s+/u).map(Number);
  if (
    cpu === undefined ||
    memTotal === undefined ||
    memAvailable === undefined ||
    ![cpu, memTotal, memAvailable].every(Number.isFinite) ||
    cpu < 0 ||
    memTotal <= 0
  )
    return null;
  return {
    usage: Math.max(cpu, 1 - memAvailable / memTotal),
    workspaceRoots: rest.map((line) => line.trim()).filter((line) => line.length > 0),
  };
}

export interface MachineCandidate {
  readonly sandboxId: string;
  /** The Boat environment the VM runs; a thread only joins a VM on its holder's choice. */
  readonly environment: string | null;
  readonly running: boolean;
  readonly workspaceRoots: ReadonlyArray<string>;
  /** Null when the VM did not report its load; such a VM is treated as busy. */
  readonly usage: number | null;
  /** The warm spare, taken only after the VMs that already serve threads. */
  readonly spare?: boolean;
}

export type MachineChoice =
  | { readonly kind: "use"; readonly sandboxId: string }
  | { readonly kind: "resume"; readonly sandboxId: string }
  | { readonly kind: "create" };

/**
 * Among the VMs on the chosen environment (any when none is chosen): a running VM
 * before a stopped one (a checkout costs less than a resume), then one with the
 * checkout, and a new VM only when none is free. A spare comes last of its kind.
 */
export function pickMachine(
  allCandidates: ReadonlyArray<MachineCandidate>,
  workspaceRoot: string,
  environment: string | null,
): MachineChoice {
  const candidates = allCandidates.filter(
    (candidate) => environment === null || candidate.environment === environment,
  );
  const hasCheckout = (candidate: MachineCandidate) =>
    candidate.workspaceRoots.includes(workspaceRoot);
  const free = candidates
    .filter(
      (candidate) =>
        candidate.running && candidate.usage !== null && candidate.usage < MAX_SHARED_USAGE,
    )
    // filter returns a new array, and Hermes has no toSorted.
    .sort(
      (left, right) =>
        Number(left.spare === true) - Number(right.spare === true) || left.usage! - right.usage!,
    );
  const stopped = candidates
    .filter((candidate) => !candidate.running)
    .sort((left, right) => Number(left.spare === true) - Number(right.spare === true));
  const running = free.find(hasCheckout) ?? free[0];
  if (running) return { kind: "use", sandboxId: running.sandboxId };
  const resumed = stopped.find(hasCheckout) ?? stopped[0];
  if (resumed) return { kind: "resume", sandboxId: resumed.sandboxId };
  return { kind: "create" };
}

/**
 * Reads `idleScript` output and says how long the VM has been without a turn,
 * counting from `startedSecondsAgo` (when it was handed out) when that is later.
 * Null while a turn runs or when the VM did not answer, so it stays on.
 */
export function idleSecondsOf(output: string, startedSecondsAgo: number): number | null {
  const match = /^(\d+)(?:[ \t]+(\d+))?\s*$/u.exec(output.trim());
  if (match === null || match[1] !== "0") return null;
  return match[2] === undefined ? startedSecondsAgo : Math.min(Number(match[2]), startedSecondsAgo);
}

export function machineStateOf(sandboxState: string): "running" | "starting" | "stopped" {
  switch (sandboxState) {
    case "ready":
    case "idle":
    case "running":
      return "running";
    case "init":
    case "provisioning":
    case "provisioned":
    case "cloning":
    case "resuming":
      return "starting";
    default:
      return "stopped";
  }
}
