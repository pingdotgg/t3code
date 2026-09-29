import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

import type {
  DesktopLocalRebuildLifecycle,
  DesktopLocalRebuildResult,
  DesktopLocalRebuildStaleness,
  DesktopLocalRebuildState,
} from "@t3tools/contracts";

const INSTALL_SCRIPT_RELATIVE_PATH = Path.join("scripts", "install-t3-dev.sh");

/** Per-command cap for the staleness check so an offline origin cannot hang it. */
const STALENESS_GIT_TIMEOUT_MS = 30_000;
const FETCH_GIT_TIMEOUT_MS = 120_000;
/** Pulls fetch before merging, so they get a longer leash than read-only checks. */
const PULL_GIT_TIMEOUT_MS = 120_000;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const COMMIT_REFERENCE_PATTERN = /^[0-9a-f]{7,40}$/i;
const ancestryCache = new Map<
  string,
  {
    behind: boolean;
    behindBy: number | null;
    readyToPull: boolean;
    readinessReason: string | null;
  }
>();

export interface GitRunResult {
  readonly stdout: string;
  readonly stderr?: string;
  readonly exitCode: number;
}

export interface GitRunOptions {
  readonly timeoutMs?: number;
}

export type GitRunner = (
  args: readonly string[],
  cwd: string,
  options?: GitRunOptions,
) => Promise<GitRunResult>;

function defaultGitRunner(
  args: readonly string[],
  cwd: string,
  options?: GitRunOptions,
): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    ChildProcess.execFile(
      "git",
      [...args],
      {
        cwd,
        timeout: options?.timeoutMs ?? STALENESS_GIT_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        // Numeric codes are process exit statuses (1 for "not ancestor",
        // 128 for "not a repo"); anything else means git never ran.
        const code = (error as { code?: unknown } | null)?.code;
        if (error && typeof code !== "number") {
          reject(error);
          return;
        }
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          exitCode: typeof code === "number" ? code : 0,
        });
      },
    );
  });
}

function normalizeSha(value: string): string | null {
  const trimmed = value.trim();
  return FULL_SHA_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

function normalizeCommitReference(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return COMMIT_REFERENCE_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * Parse `git ls-remote --symref origin HEAD`. The symref line names the
 * remote default branch; without it only the tip SHA is known.
 */
export function parseLsRemoteSymrefHead(stdout: string): {
  sha: string;
  branch: string | null;
} | null {
  let branch: string | null = null;
  let sha: string | null = null;
  for (const line of stdout.split("\n")) {
    const symref = line.match(/^ref: refs\/heads\/(\S+)\s+HEAD\s*$/);
    if (symref?.[1]) {
      branch = symref[1];
      continue;
    }
    const tip = line.match(/^([0-9a-f]{40})\s+HEAD\s*$/i);
    if (tip?.[1]) {
      sha = tip[1].toLowerCase();
    }
  }
  return sha ? { sha, branch } : null;
}

export function decideRebuildStaleness(input: {
  readonly baseSha: string;
  readonly remoteSha: string;
  /** Null when the ancestry comparison itself could not run. */
  readonly mergeBaseIsAncestor: boolean | null;
  readonly behindBy: number | null;
}): { behind: boolean; error: string | null } {
  if (input.remoteSha === input.baseSha) {
    return { behind: false, error: null };
  }
  if (input.mergeBaseIsAncestor === null) {
    return { behind: false, error: "Could not compare the running build with the remote tip." };
  }
  // Ahead or diverged: rebuilding the current checkout would not bring the
  // remote branch in, so the refresh icon stays off.
  if (!input.mergeBaseIsAncestor) {
    return { behind: false, error: null };
  }
  return { behind: true, error: null };
}

function unavailableStaleness(reason: string): DesktopLocalRebuildStaleness {
  return {
    available: false,
    behind: false,
    behindBy: null,
    readyToPull: false,
    readinessReason: reason,
    localBranch: null,
    localSha: null,
    remoteBranch: null,
    remoteSha: null,
    buildSha: null,
    checkedAt: null,
    error: reason,
  };
}

/**
 * Compare the build and source checkout with the remote default branch. Fetch
 * uses a temporary private ref, which is deleted after the object transfer;
 * no local branch, worktree, FETCH_HEAD, or remote-tracking ref is changed.
 */
export async function checkLocalDevRebuildStaleness(input: {
  readonly enabled: boolean;
  readonly sourceRoot: string | null;
  readonly buildSha: string | null;
  readonly runGit?: GitRunner;
}): Promise<DesktopLocalRebuildStaleness> {
  if (!input.enabled || !input.sourceRoot) {
    return unavailableStaleness("Local rebuilds are unavailable.");
  }
  const runGit = input.runGit ?? defaultGitRunner;
  const cwd = input.sourceRoot;
  const failed = (
    message: string,
    partial?: Partial<DesktopLocalRebuildStaleness>,
  ): DesktopLocalRebuildStaleness => ({
    available: true,
    behind: false,
    behindBy: null,
    readyToPull: false,
    readinessReason: partial?.readinessReason ?? message,
    localBranch: null,
    localSha: null,
    remoteBranch: null,
    remoteSha: null,
    buildSha: input.buildSha,
    checkedAt: new Date().toISOString(),
    error: message,
    ...partial,
  });

  let head: GitRunResult;
  let branch: GitRunResult;
  let workingTree: GitRunResult;
  let lsRemote: GitRunResult;
  try {
    [head, branch, workingTree, lsRemote] = await Promise.all([
      runGit(["rev-parse", "HEAD"], cwd),
      runGit(["branch", "--show-current"], cwd),
      runGit(["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"], cwd),
      runGit(["ls-remote", "--symref", "origin", "HEAD"], cwd),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failed(`Could not reach the remote: ${message}`);
  }

  const localSha = head.exitCode === 0 ? normalizeSha(head.stdout) : null;
  if (!localSha) {
    return failed("The source checkout is not a git repository.");
  }
  const localBranch = branch.exitCode === 0 ? branch.stdout.trim() || null : null;
  const parsed = lsRemote.exitCode === 0 ? parseLsRemoteSymrefHead(lsRemote.stdout) : null;
  if (!parsed) {
    return failed("Could not read the remote default branch.", {
      localBranch,
      localSha,
    });
  }

  let readinessReason: string | null = null;
  if (!parsed.branch) {
    readinessReason = "Could not determine the remote default branch.";
  } else if (localBranch === null) {
    readinessReason = `Checkout is detached; switch to '${parsed.branch}' to pull its latest changes.`;
  } else if (localBranch !== parsed.branch) {
    readinessReason = `Checkout is on '${localBranch}'; switch to '${parsed.branch}' to pull its latest changes.`;
  } else if (workingTree.exitCode !== 0) {
    readinessReason = "Could not inspect the working tree.";
  } else if (workingTree.stdout.trim().length > 0) {
    readinessReason = `Checkout has local changes; stash, commit, or discard them before pulling origin/${parsed.branch}.`;
  }

  const canCompareSource = readinessReason === null;
  const buildReference = normalizeCommitReference(input.buildSha);
  if (input.buildSha && !buildReference) {
    return failed("The running build commit metadata is invalid.", {
      localBranch,
      localSha,
      remoteBranch: parsed.branch,
      remoteSha: parsed.sha,
    });
  }
  // The running build's commit is the honest base; without embedded metadata
  // the checkout HEAD is the closest observable proxy.
  let baseSha = buildReference && FULL_SHA_PATTERN.test(buildReference) ? buildReference : null;
  if (!baseSha && buildReference) {
    try {
      const resolved = await runGit(["rev-parse", "--verify", `${buildReference}^{commit}`], cwd);
      baseSha = resolved.exitCode === 0 ? normalizeSha(resolved.stdout) : null;
    } catch {
      baseSha = null;
    }
  }
  baseSha ??= input.buildSha ? null : localSha;

  const complete = (
    extra: Partial<DesktopLocalRebuildStaleness>,
  ): DesktopLocalRebuildStaleness => ({
    available: true,
    behind: false,
    behindBy: null,
    readyToPull: false,
    readinessReason,
    localBranch,
    localSha,
    remoteBranch: parsed.branch,
    remoteSha: parsed.sha,
    buildSha: input.buildSha,
    checkedAt: new Date().toISOString(),
    error: null,
    ...extra,
  });

  let remoteHistoryFetched = false;
  if (!baseSha) {
    const fetched = await fetchRemoteDefaultBranch(runGit, cwd, parsed.branch);
    if (!fetched.ok) {
      return complete({
        error: `Could not obtain remote history: ${fetched.message}`,
        readinessReason:
          readinessReason ??
          "Could not compare the source checkout with the remote default branch.",
      });
    }
    remoteHistoryFetched = true;
    if (buildReference) {
      try {
        const resolved = await runGit(["rev-parse", "--verify", `${buildReference}^{commit}`], cwd);
        baseSha = resolved.exitCode === 0 ? normalizeSha(resolved.stdout) : null;
      } catch {
        baseSha = null;
      }
    }
    if (!baseSha) {
      return complete({
        error: "Could not resolve the running build commit in the source checkout.",
        readinessReason:
          readinessReason ??
          "Could not compare the source checkout with the remote default branch.",
      });
    }
  }

  const needsHistory = baseSha !== parsed.sha || (canCompareSource && localSha !== parsed.sha);
  const useCache = input.runGit === undefined;
  const cacheKey = JSON.stringify([
    cwd,
    baseSha,
    parsed.sha,
    localSha,
    localBranch,
    workingTree.exitCode === 0 ? workingTree.stdout : null,
  ]);
  const cached = useCache ? ancestryCache.get(cacheKey) : undefined;
  if (needsHistory && !cached && !remoteHistoryFetched) {
    const fetched = await fetchRemoteDefaultBranch(runGit, cwd, parsed.branch);
    if (!fetched.ok) {
      return complete({
        error: `Could not obtain remote history: ${fetched.message}`,
        readinessReason:
          readinessReason ??
          "Could not compare the source checkout with the remote default branch.",
      });
    }
  }

  if (cached) {
    return complete(cached);
  }

  let behind = false;
  let behindBy: number | null = null;
  let error: string | null = null;
  if (parsed.sha !== baseSha) {
    const buildAncestor = await isAncestor(runGit, cwd, baseSha, parsed.sha);
    const decision = decideRebuildStaleness({
      baseSha,
      remoteSha: parsed.sha,
      mergeBaseIsAncestor: buildAncestor,
      behindBy: null,
    });
    behind = decision.behind;
    error = decision.error;

    if (behind) {
      try {
        const count = await runGit(["rev-list", "--count", `${baseSha}..${parsed.sha}`], cwd);
        if (count.exitCode === 0) {
          const parsedCount = Number.parseInt(count.stdout.trim(), 10);
          behindBy = Number.isFinite(parsedCount) && parsedCount > 0 ? parsedCount : null;
        }
      } catch {
        behindBy = null;
      }
    }
  }

  let readyToPull = false;
  if (canCompareSource) {
    if (localSha === parsed.sha) {
      readyToPull = true;
    } else {
      const sourceAncestor = await isAncestor(runGit, cwd, localSha, parsed.sha);
      if (sourceAncestor === true) {
        readyToPull = true;
      } else if (sourceAncestor === false) {
        const remoteAncestor = await isAncestor(runGit, cwd, parsed.sha, localSha);
        if (remoteAncestor === true) {
          readyToPull = true;
        } else if (remoteAncestor === false) {
          readinessReason =
            "The source checkout and remote default branch have diverged; reconcile them before pulling.";
        } else {
          readinessReason = "Could not compare the source checkout with the remote default branch.";
        }
      } else {
        readinessReason = "Could not compare the source checkout with the remote default branch.";
      }
    }
  }

  const result = {
    behind,
    behindBy,
    readyToPull,
    readinessReason,
  };
  if (useCache && error === null && (readyToPull || readinessReason !== null)) {
    ancestryCache.set(cacheKey, result);
    if (ancestryCache.size > 64) {
      const oldest = ancestryCache.keys().next().value;
      if (oldest !== undefined) ancestryCache.delete(oldest);
    }
  }
  return complete({ ...result, error });
}

async function fetchRemoteDefaultBranch(
  runGit: GitRunner,
  cwd: string,
  branch: string | null,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!branch) {
    return { ok: false, message: "the remote default branch name is unavailable." };
  }
  const ref = `refs/heads/${branch}:`;
  const temporaryRef = `refs/t3code/local-rebuild-check/${process.pid}-${Crypto.randomUUID()}`;
  let shallow = false;
  try {
    const shallowResult = await runGit(["rev-parse", "--is-shallow-repository"], cwd);
    shallow = shallowResult.exitCode === 0 && shallowResult.stdout.trim() === "true";
  } catch {
    // A later ancestry error reports missing history when this check is unavailable.
  }

  let fetched: GitRunResult | null = null;
  let fetchError: string | null = null;
  try {
    fetched = await runGit(
      [
        "fetch",
        ...(shallow ? ["--unshallow"] : []),
        "--no-tags",
        "--no-write-fetch-head",
        "--refmap=",
        "origin",
        `${ref}${temporaryRef}`,
      ],
      cwd,
      { timeoutMs: FETCH_GIT_TIMEOUT_MS },
    );
    if (fetched.exitCode !== 0) {
      fetchError =
        [fetched.stderr, fetched.stdout]
          .map((output) => output?.trim())
          .find((output) => output && output.length > 0) ?? "git fetch failed.";
    }
  } catch (error) {
    fetchError = error instanceof Error ? error.message : String(error);
  }

  let cleanupError: string | null = null;
  try {
    const cleanup = await runGit(["update-ref", "-d", temporaryRef], cwd);
    if (cleanup.exitCode !== 0) {
      cleanupError = cleanup.stderr?.trim() || "git could not remove the temporary ref.";
    }
  } catch (error) {
    cleanupError = error instanceof Error ? error.message : String(error);
  }
  if (cleanupError) {
    return {
      ok: false,
      message: `Could not remove temporary remote-history ref ${temporaryRef}: ${cleanupError}`,
    };
  }
  if (fetchError) {
    return { ok: false, message: fetchError };
  }
  return fetched?.exitCode === 0 ? { ok: true } : { ok: false, message: "git fetch failed." };
}

async function isAncestor(
  runGit: GitRunner,
  cwd: string,
  possibleAncestor: string,
  descendant: string,
): Promise<boolean | null> {
  try {
    const result = await runGit(["merge-base", "--is-ancestor", possibleAncestor, descendant], cwd);
    return result.exitCode === 0 ? true : result.exitCode === 1 ? false : null;
  } catch {
    return null;
  }
}

/**
 * Fast-forward the checkout to the remote default branch before rebuilding,
 * so the new build actually contains the advertised remote changes. The
 * branch is resolved fresh via ls-remote (never trusted from a stale poll),
 * and the pull only runs when the checkout is on that branch with a clean
 * working tree: anything else (feature branch, detached HEAD, local
 * changes, no default branch) aborts with an actionable message instead of
 * mutating local work or updating the wrong ref. Never merges: fast-forward
 * failures surface git's own message and the rebuild is aborted before
 * anything is built or restarted.
 */
export async function pullLatestCheckoutChanges(
  sourceRoot: string,
  runGit: GitRunner = defaultGitRunner,
): Promise<{ ok: boolean; message: string | null }> {
  const fail = (message: string): { ok: boolean; message: string } => ({ ok: false, message });

  let remote: GitRunResult;
  let current: GitRunResult;
  try {
    [remote, current] = await Promise.all([
      runGit(["ls-remote", "--symref", "origin", "HEAD"], sourceRoot),
      runGit(["branch", "--show-current"], sourceRoot),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`Could not pull latest changes: ${message}`);
  }
  const parsed = remote.exitCode === 0 ? parseLsRemoteSymrefHead(remote.stdout) : null;
  if (!parsed || !parsed.branch) {
    return fail("Could not determine the remote default branch.");
  }
  const currentBranch = current.exitCode === 0 ? current.stdout.trim() || null : null;
  if (currentBranch === null) {
    return fail(`Checkout is detached; switch to '${parsed.branch}' to pull its latest changes.`);
  }
  if (currentBranch !== parsed.branch) {
    return fail(
      `Checkout is on '${currentBranch}'; switch to '${parsed.branch}' to pull its latest changes.`,
    );
  }

  // Clean-tree gate before the mutation boundary: a fast-forward can still
  // move a worktree with unrelated edits, and a configured pull.autostash
  // would silently stash/apply around it. Full-visibility flags match
  // ProjectAutoPull so user status preferences cannot hide changes.
  let workingTree: GitRunResult;
  try {
    workingTree = await runGit(
      ["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"],
      sourceRoot,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`Could not inspect the working tree: ${message}`);
  }
  if (workingTree.exitCode !== 0) {
    return fail("Could not inspect the working tree.");
  }
  if (workingTree.stdout.trim().length > 0) {
    return fail(
      `Checkout has local changes; stash, commit, or discard them before pulling origin/${parsed.branch}.`,
    );
  }

  // Explicit remote + branch (not bare `git pull`): independent of whatever
  // upstream the current branch happens to track. Autostash is disabled
  // explicitly so user config cannot move local work around the pull.
  let pull: GitRunResult;
  try {
    pull = await runGit(
      [
        "-c",
        "merge.autostash=false",
        "-c",
        "rebase.autoStash=false",
        "pull",
        "--ff-only",
        "origin",
        parsed.branch,
      ],
      sourceRoot,
      {
        timeoutMs: PULL_GIT_TIMEOUT_MS,
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`Could not pull latest changes: ${message}`);
  }
  if (pull.exitCode !== 0) {
    const detail = [pull.stderr, pull.stdout]
      .map((output) => output?.trim())
      .find((output) => output && output.length > 0);
    return fail(
      detail
        ? `Could not fast-forward to origin/${parsed.branch}: ${detail}`
        : `Could not fast-forward to origin/${parsed.branch}.`,
    );
  }
  return { ok: true, message: null };
}

export interface LocalRebuildStartDeps {
  readonly isStarted: () => boolean;
  readonly setStarted: (started: boolean) => void;
  readonly getState: () => DesktopLocalRebuildState;
  readonly pullLatest: (sourceRoot: string) => Promise<{ ok: boolean; message: string | null }>;
  readonly launch: (
    state: DesktopLocalRebuildState,
    onExit: (exitCode: number | null, signal: NodeJS.Signals | null) => void,
  ) => Promise<DesktopLocalRebuildResult>;
  readonly onLifecycle?: (state: Omit<DesktopLocalRebuildLifecycle, "revision">) => void;
  readonly alreadyStartedLogPath: string;
  readonly options: { readonly pullLatest?: unknown } | undefined;
}

/**
 * Single-rebuild gate around an optional pull plus the installer spawn. The
 * guard is set synchronously before the first await so concurrent invokes —
 * double-clicks, two windows, a slow fetch — serialize on it instead of
 * running overlapping pulls and installs. The shared lifecycle remains
 * running until the detached installer exits.
 */
export async function runLocalRebuildStart(
  deps: LocalRebuildStartDeps,
): Promise<DesktopLocalRebuildResult> {
  if (deps.isStarted()) {
    return {
      accepted: false,
      logPath: deps.alreadyStartedLogPath,
      message: "A local rebuild is already in progress.",
    };
  }
  deps.setStarted(true);
  deps.onLifecycle?.({ phase: "running", logPath: null, message: null });
  const fail = (result: DesktopLocalRebuildResult): DesktopLocalRebuildResult => {
    deps.setStarted(false);
    deps.onLifecycle?.({
      phase: "failed",
      logPath: result.logPath,
      message: result.message ?? "Local rebuild failed before the installer completed.",
    });
    return result;
  };
  const state = deps.getState();
  if (deps.options?.pullLatest === true) {
    if (!state.enabled || !state.sourceRoot) {
      return fail({
        accepted: false,
        logPath: null,
        message: state.reason ?? "Local rebuilds are unavailable.",
      });
    }
    let pull: { ok: boolean; message: string | null };
    try {
      pull = await deps.pullLatest(state.sourceRoot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail({ accepted: false, logPath: null, message });
    }
    if (!pull.ok) {
      return fail({ accepted: false, logPath: null, message: pull.message });
    }
  }
  let result: DesktopLocalRebuildResult;
  try {
    result = await deps.launch(state, (exitCode, signal) => {
      deps.setStarted(false);
      const completed = exitCode === 0 && signal === null;
      deps.onLifecycle?.({
        phase: completed ? "completed" : "failed",
        logPath: Path.join(Path.dirname(deps.alreadyStartedLogPath), "dev-rebuild.log"),
        message: completed
          ? null
          : signal
            ? `The installer was terminated by ${signal}.`
            : exitCode === null
              ? "The installer could not be started; inspect the rebuild log."
              : `The installer exited with code ${exitCode}.`,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail({ accepted: false, logPath: null, message });
  }
  if (!result.accepted) {
    return fail(result);
  }
  if (deps.isStarted()) {
    deps.onLifecycle?.({ phase: "running", logPath: result.logPath, message: null });
  }
  return result;
}

export function persistLocalDevRebuildLifecycle(
  path: string,
  lifecycle: DesktopLocalRebuildLifecycle,
  processId: number | null,
): void {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  FS.mkdirSync(Path.dirname(path), { recursive: true });
  FS.writeFileSync(temporaryPath, JSON.stringify({ lifecycle, processId }), { mode: 0o600 });
  FS.renameSync(temporaryPath, path);
}

export function restoreLocalDevRebuildLifecycle(
  path: string,
  fallbackLogPath: string,
): {
  readonly lifecycle: DesktopLocalRebuildLifecycle;
  readonly processId: number | null;
  readonly error: string | null;
} {
  const idle: DesktopLocalRebuildLifecycle = {
    revision: 0,
    phase: "idle",
    logPath: null,
    message: null,
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(FS.readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { lifecycle: idle, processId: null, error: null };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      lifecycle: {
        revision: 1,
        phase: "failed",
        logPath: fallbackLogPath,
        message: "Could not restore the previous rebuild status. Inspect the local rebuild log.",
      },
      processId: null,
      error: message,
    };
  }

  if (typeof parsed !== "object" || parsed === null || !("lifecycle" in parsed)) {
    return invalidPersistedLifecycle(
      "The persisted local rebuild status has an invalid shape.",
      fallbackLogPath,
    );
  }
  const record = parsed as { lifecycle?: unknown; processId?: unknown };
  const lifecycle = record.lifecycle;
  if (!isPersistedLocalRebuildLifecycle(lifecycle)) {
    return invalidPersistedLifecycle(
      "The persisted local rebuild lifecycle is invalid.",
      fallbackLogPath,
    );
  }

  const processId =
    typeof record.processId === "number" &&
    Number.isInteger(record.processId) &&
    record.processId > 0
      ? record.processId
      : null;
  if (lifecycle.phase !== "running") {
    return { lifecycle, processId: null, error: null };
  }

  const logPath = lifecycle.logPath ?? fallbackLogPath;
  const exitResult = lifecycle.logPath
    ? readInstallerExitCode(`${logPath}.exit-code`)
    : { kind: "missing" as const };
  if (exitResult.kind === "complete") {
    return {
      lifecycle: {
        revision: lifecycle.revision + 1,
        phase: exitResult.exitCode === 0 ? "completed" : "failed",
        logPath,
        message:
          exitResult.exitCode === 0
            ? null
            : `The installer exited with code ${exitResult.exitCode}.`,
      },
      processId: null,
      error: null,
    };
  }
  if (exitResult.kind === "invalid") {
    return {
      lifecycle: {
        revision: lifecycle.revision + 1,
        phase: "failed",
        logPath,
        message: `Could not read the installer result: ${exitResult.message}`,
      },
      processId: null,
      error: exitResult.message,
    };
  }
  if (processId !== null && isProcessRunning(processId)) {
    return { lifecycle: { ...lifecycle, logPath }, processId, error: null };
  }
  return {
    lifecycle: {
      revision: lifecycle.revision + 1,
      phase: "failed",
      logPath,
      message: "The installer stopped before reporting its result. Inspect the local rebuild log.",
    },
    processId: null,
    error: null,
  };
}

function invalidPersistedLifecycle(
  message: string,
  fallbackLogPath: string,
): {
  lifecycle: DesktopLocalRebuildLifecycle;
  processId: null;
  error: string;
} {
  return {
    lifecycle: {
      revision: 1,
      phase: "failed",
      logPath: fallbackLogPath,
      message,
    },
    processId: null,
    error: message,
  };
}

function isPersistedLocalRebuildLifecycle(value: unknown): value is DesktopLocalRebuildLifecycle {
  if (typeof value !== "object" || value === null) return false;
  const lifecycle = value as Record<string, unknown>;
  return (
    typeof lifecycle.revision === "number" &&
    Number.isInteger(lifecycle.revision) &&
    (lifecycle.phase === "idle" ||
      lifecycle.phase === "running" ||
      lifecycle.phase === "completed" ||
      lifecycle.phase === "failed") &&
    (typeof lifecycle.logPath === "string" || lifecycle.logPath === null) &&
    (typeof lifecycle.message === "string" || lifecycle.message === null)
  );
}

function readInstallerExitCode(
  resultPath: string,
):
  | { kind: "missing" }
  | { kind: "complete"; exitCode: number }
  | { kind: "invalid"; message: string } {
  let raw: string;
  try {
    raw = FS.readFileSync(resultPath, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return {
      kind: "invalid",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (!/^\d+$/.test(raw)) {
    return { kind: "invalid", message: "the exit-code file is malformed." };
  }
  const exitCode = Number.parseInt(raw, 10);
  return Number.isSafeInteger(exitCode) && exitCode <= 255
    ? { kind: "complete", exitCode }
    : { kind: "invalid", message: "the exit code is outside the process status range." };
}

function isProcessRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readEmbeddedDevSourceRoot(appRoot: string): string | null {
  try {
    const raw = FS.readFileSync(Path.join(appRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { t3codeDevSourceRoot?: unknown };
    return typeof parsed.t3codeDevSourceRoot === "string"
      ? parsed.t3codeDevSourceRoot.trim() || null
      : null;
  } catch {
    return null;
  }
}

export function resolveLocalDevRebuildState(input: {
  readonly isPackaged: boolean;
  readonly isDevAppFlavor: boolean;
  readonly platform: NodeJS.Platform;
  readonly sourceRoot: string | null;
}): DesktopLocalRebuildState {
  const unavailable = (reason: string): DesktopLocalRebuildState => ({
    enabled: false,
    sourceRoot: null,
    reason,
  });

  if (!input.isPackaged || !input.isDevAppFlavor) {
    return unavailable("Local rebuilds are only available in packaged Dev builds.");
  }
  if (input.platform !== "darwin") {
    return unavailable("Local rebuilds are currently available only on macOS.");
  }
  if (!input.sourceRoot) {
    return unavailable("This Dev build does not identify its source checkout.");
  }

  try {
    const sourceRoot = FS.realpathSync(Path.resolve(input.sourceRoot));
    const packageJsonPath = Path.join(sourceRoot, "package.json");
    const installScriptPath = Path.join(sourceRoot, INSTALL_SCRIPT_RELATIVE_PATH);
    const packageJson = JSON.parse(FS.readFileSync(packageJsonPath, "utf8")) as {
      name?: unknown;
    };
    if (packageJson.name !== "@t3tools/monorepo" || !FS.statSync(installScriptPath).isFile()) {
      return unavailable("The embedded source checkout is not a valid T3 Code repository.");
    }
    return { enabled: true, sourceRoot, reason: null };
  } catch {
    return unavailable("The embedded source checkout is no longer available.");
  }
}

export function launchLocalDevRebuild(
  state: DesktopLocalRebuildState,
  logDirectory: string,
  spawn: typeof ChildProcess.spawn = ChildProcess.spawn,
  onExit: (exitCode: number | null, signal: NodeJS.Signals | null) => void = () => {},
  onSpawn: (processId: number | null) => void = () => {},
): Promise<DesktopLocalRebuildResult> {
  if (!state.enabled || !state.sourceRoot) {
    return Promise.resolve({ accepted: false, logPath: null, message: state.reason });
  }

  const logPath = Path.join(logDirectory, "dev-rebuild.log");
  const resultPath = `${logPath}.exit-code`;
  try {
    FS.mkdirSync(logDirectory, { recursive: true });
    FS.rmSync(resultPath, { force: true });
    FS.writeFileSync(logPath, `[${new Date().toISOString()}] Local rebuild requested.\n`);
    const child = spawn("/bin/bash", [Path.join(state.sourceRoot, INSTALL_SCRIPT_RELATIVE_PATH)], {
      cwd: state.sourceRoot,
      detached: true,
      env: {
        ...process.env,
        T3CODE_DEV_REBUILD_LOG_PATH: logPath,
        T3CODE_DEV_REBUILD_RESULT_PATH: resultPath,
      },
      stdio: "ignore",
    });

    return new Promise((resolve) => {
      let settled = false;
      let exited = false;
      const notifyExit = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
        if (exited) return;
        exited = true;
        onExit(exitCode, signal);
      };
      child.once("error", (error) => {
        FS.appendFileSync(logPath, `[desktop] Failed to launch local rebuild: ${error.message}\n`);
        if (!settled) {
          settled = true;
          resolve({ accepted: false, logPath, message: error.message });
        }
      });
      child.once("exit", (exitCode, signal) => notifyExit(exitCode, signal));
      child.once("spawn", () => {
        settled = true;
        onSpawn(child.pid ?? null);
        child.unref();
        resolve({ accepted: true, logPath, message: null });
      });
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return Promise.resolve({ accepted: false, logPath, message });
  }
}
