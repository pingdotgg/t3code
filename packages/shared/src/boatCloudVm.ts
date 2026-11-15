/**
 * What runs on Boat cloud VMs, and how a holder picks one. Boat VMs are Ubuntu
 * with systemd user services, git, Node and sqlite3, and the agent CLIs.
 */

const VM_HOME = "/home/user";
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

const q = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

// `t3 update` can install a newer runtime, so prefer the newest one, then an npm install.
const T3 = `T3="$(ls -1d ${VM_HOME}/.t3/runtime/versions/*/t3 2>/dev/null | sort -V | tail -n1)"; [ -x "$T3" ] || T3="$(command -v t3 || true)"; [ -n "$T3" ] || { echo "T3 Code is not installed on this VM." >&2; exit 1; }`;

/** Installs T3 Code from npm, for a holder that has no runner script to upload (the phone). */
export const npmInstallServerScript = (version: string) => `set -e
npm install -g --silent ${q(`t3@${version}`)}
t3 service install`;

export const extractSkillsScript = `set -e
tar -xzf ${VM_SKILLS_ARCHIVE} -C ${VM_HOME}
rm -f ${VM_SKILLS_ARCHIVE}`;

const ACTIVE_RUN_STATUSES = "'preparing','queued','starting','running','waiting'";
const ACTIVE_RUNS_QUERY = `db=${VM_HOME}/.t3/userdata/statev2.sqlite
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
if [ -n "$changed" ]; then
  systemctl --user daemon-reload
  systemctl --user enable t3-boat-keepalive.timer >/dev/null 2>&1 || true
  systemctl --user restart t3-boat-keepalive.timer >/dev/null 2>&1 || true
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
rm -rf ${VM_HOME}/.t3/userdata/logs/* ${VM_HOME}/.t3/usage-host-id
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

/** Prints the environment id once the server answers. */
export const ensureServerScript = `${syncCredentialsScript}
systemctl --user start t3code.service >/dev/null 2>&1 || true
for i in $(seq 1 120); do
  out="$(curl -sf --max-time 2 http://127.0.0.1:${VM_T3_PORT}/.well-known/t3/environment)" && { printf '%s' "$out"; exit 0; }
  sleep 0.5
done
echo "T3 Code did not start on this VM." >&2
exit 1`;

/**
 * First line `load1 cpus memTotalKb memAvailableKb`, then one line per checkout
 * under ~/projects, at `host/namespace/repo`. It does not look inside a checkout.
 */
export const measureScript = `printf '%s %s %s %s\\n' "$(cut -d' ' -f1 /proc/loadavg)" "$(nproc)" "$(awk '/^MemTotal:/{print $2}' /proc/meminfo)" "$(awk '/^MemAvailable:/{print $2}' /proc/meminfo)"
find ${VM_HOME}/projects -mindepth 3 -maxdepth 8 -type d -exec test -d '{}/.git' ';' -print -prune 2>/dev/null; exit 0`;

export const BASE_BRANCH_MISSING_EXIT = 3;

/**
 * Fails, naming the branch, when the clone in `$dir` has no remote copy of it.
 * The clone has none of the client's local branches, so a thread can only
 * start from one that was pushed.
 */
export const baseBranchCheckScript = (baseBranch: string, repositoryName: string) => {
  const has = (ref: string) =>
    `git -C "$dir" rev-parse --verify --quiet ${q(`${ref}^{commit}`)} >/dev/null`;
  return `if ! ${has(`refs/remotes/origin/${baseBranch}`)} && ! ${has(`refs/remotes/${baseBranch}`)}; then
  echo ${q(`${baseBranch} is not on ${repositoryName}. Push it, or start from a pushed branch.`)} >&2
  exit ${BASE_BRANCH_MISSING_EXIT}
fi`;
};

/** Clones the repository once and refreshes it after. Runs while the server starts. */
export const checkoutScript = (repository: ParsedRepository, baseBranch: string | null) => `set -e
${prepareVmScript}
dir=${q(repository.workspaceRoot)}
if [ -d "$dir/.git" ]; then
  git -C "$dir" fetch --prune --quiet origin
else
  mkdir -p "$(dirname "$dir")"
  git clone --quiet ${q(repository.cloneUrl)} "$dir"
fi
${baseBranch === null ? "" : baseBranchCheckScript(baseBranch, repository.name)}`;

/** Adds the project to the running server, then mints a pairing code, in one round trip. */
export const addProjectAndPairScript = (workspaceRoot: string | null, label: string) => `set -e
${T3}
${workspaceRoot === null ? "" : `"$T3" project add ${q(workspaceRoot)} >/dev/null 2>&1 || true`}
"$T3" auth pairing create --json --ttl 10m --label ${q(label)}`;

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

/** A VM above this share of CPU or memory gets no new sessions. */
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
  /** The larger of CPU and memory use, 0 to 1. */
  readonly usage: number;
  /** Checkout directories on the VM. */
  readonly workspaceRoots: ReadonlyArray<string>;
}

/** Reads `measureScript` output. */
export function parseMeasure(output: string): MachineMeasure | null {
  const [first = "", ...rest] = output.trim().split("\n");
  const [load, cpus, memTotal, memAvailable] = first.trim().split(/\s+/u).map(Number);
  if (
    load === undefined ||
    cpus === undefined ||
    memTotal === undefined ||
    memAvailable === undefined ||
    ![load, cpus, memTotal, memAvailable].every(Number.isFinite) ||
    cpus <= 0 ||
    memTotal <= 0
  )
    return null;
  return {
    usage: Math.max(load / cpus, 1 - memAvailable / memTotal),
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
}

export type MachineChoice =
  | { readonly kind: "use"; readonly sandboxId: string }
  | { readonly kind: "resume"; readonly sandboxId: string }
  | { readonly kind: "create" };

/**
 * Among the VMs on the chosen environment (any, when none is chosen), prefers
 * one that already has the checkout, then a running VM over a stopped one, and
 * spends a new VM only when every running one is busy.
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
    .sort((left, right) => left.usage! - right.usage!);
  const stopped = candidates.filter((candidate) => !candidate.running);
  const freeWithCheckout = free.find(hasCheckout);
  if (freeWithCheckout) return { kind: "use", sandboxId: freeWithCheckout.sandboxId };
  const stoppedWithCheckout = stopped.find(hasCheckout);
  if (stoppedWithCheckout) return { kind: "resume", sandboxId: stoppedWithCheckout.sandboxId };
  if (free[0]) return { kind: "use", sandboxId: free[0].sandboxId };
  if (stopped[0]) return { kind: "resume", sandboxId: stopped[0].sandboxId };
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
