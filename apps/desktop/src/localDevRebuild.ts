import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";

import type {
  DesktopLocalRebuildResult,
  DesktopLocalRebuildStaleness,
  DesktopLocalRebuildState,
} from "@t3tools/contracts";

const INSTALL_SCRIPT_RELATIVE_PATH = Path.join("scripts", "install-t3-dev.sh");

/** Per-command cap for the staleness check so an offline origin cannot hang it. */
const STALENESS_GIT_TIMEOUT_MS = 30_000;
/** Pulls fetch before merging, so they get a longer leash than read-only checks. */
const PULL_GIT_TIMEOUT_MS = 120_000;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/i;

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
 * Check whether the remote default branch moved past the running build.
 * Read-only: `ls-remote` never fetches and no local ref is mutated.
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
  let lsRemote: GitRunResult;
  try {
    [head, branch, lsRemote] = await Promise.all([
      runGit(["rev-parse", "HEAD"], cwd),
      runGit(["branch", "--show-current"], cwd),
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
  const parsed = lsRemote.exitCode === 0 ? parseLsRemoteSymrefHead(lsRemote.stdout) : null;
  if (!parsed) {
    return failed("Could not read the remote default branch.", {
      localBranch: branch.exitCode === 0 ? branch.stdout.trim() || null : null,
      localSha,
    });
  }

  // The running build's commit is the honest base; without embedded metadata
  // the checkout HEAD is the closest observable proxy.
  const baseSha = input.buildSha ?? localSha;
  const localBranch = branch.exitCode === 0 ? branch.stdout.trim() || null : null;
  const complete = (
    extra: Partial<DesktopLocalRebuildStaleness>,
  ): DesktopLocalRebuildStaleness => ({
    available: true,
    behind: false,
    behindBy: null,
    localBranch,
    localSha,
    remoteBranch: parsed.branch,
    remoteSha: parsed.sha,
    buildSha: input.buildSha,
    checkedAt: new Date().toISOString(),
    error: null,
    ...extra,
  });

  if (parsed.sha === baseSha) {
    return complete({});
  }

  let mergeBase: GitRunResult;
  try {
    mergeBase = await runGit(["merge-base", "--is-ancestor", baseSha, parsed.sha], cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return complete({ error: `Could not compare commits: ${message}` });
  }
  // Exit 0 means ancestor (behind); 1 means not. Anything else (e.g. 128 for
  // objects missing from a shallow clone) leaves the answer unknown.
  const mergeBaseIsAncestor =
    mergeBase.exitCode === 0 ? true : mergeBase.exitCode === 1 ? false : null;
  const decision = decideRebuildStaleness({
    baseSha,
    remoteSha: parsed.sha,
    mergeBaseIsAncestor,
    behindBy: null,
  });
  if (!decision.behind) {
    return complete({ error: decision.error });
  }

  let behindBy: number | null = null;
  try {
    const count = await runGit(["rev-list", "--count", `${baseSha}..${parsed.sha}`], cwd);
    if (count.exitCode === 0) {
      const parsed_count = Number.parseInt(count.stdout.trim(), 10);
      behindBy = Number.isFinite(parsed_count) && parsed_count > 0 ? parsed_count : null;
    }
  } catch {
    behindBy = null;
  }
  return complete({ behind: true, behindBy });
}

/**
 * Fast-forward the checkout to its upstream before rebuilding, so the new
 * build actually contains the remote changes. Never merges or touches work
 * the fast-forward would overwrite: those cases fail with git's own message
 * and the rebuild is aborted before anything is built or restarted.
 */
export async function pullLatestCheckoutChanges(
  sourceRoot: string,
  runGit: GitRunner = defaultGitRunner,
): Promise<{ ok: boolean; message: string | null }> {
  let pull: GitRunResult;
  try {
    pull = await runGit(["pull", "--ff-only"], sourceRoot, { timeoutMs: PULL_GIT_TIMEOUT_MS });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Could not pull latest changes: ${message}` };
  }
  if (pull.exitCode !== 0) {
    const detail = [pull.stderr, pull.stdout]
      .map((output) => output?.trim())
      .find((output) => output && output.length > 0);
    return {
      ok: false,
      message: detail
        ? `Could not fast-forward the checkout: ${detail}`
        : "Could not fast-forward the checkout to its upstream.",
    };
  }
  return { ok: true, message: null };
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
  onExit: () => void = () => {},
): Promise<DesktopLocalRebuildResult> {
  if (!state.enabled || !state.sourceRoot) {
    return Promise.resolve({ accepted: false, logPath: null, message: state.reason });
  }

  const logPath = Path.join(logDirectory, "dev-rebuild.log");
  try {
    FS.mkdirSync(logDirectory, { recursive: true });
    FS.writeFileSync(logPath, `[${new Date().toISOString()}] Local rebuild requested.\n`);
    const child = spawn("/bin/bash", [Path.join(state.sourceRoot, INSTALL_SCRIPT_RELATIVE_PATH)], {
      cwd: state.sourceRoot,
      detached: true,
      env: { ...process.env, T3CODE_DEV_REBUILD_LOG_PATH: logPath },
      stdio: "ignore",
    });

    return new Promise((resolve) => {
      let settled = false;
      let exited = false;
      const notifyExit = (): void => {
        if (exited) return;
        exited = true;
        onExit();
      };
      child.once("error", (error) => {
        FS.appendFileSync(logPath, `[desktop] Failed to launch local rebuild: ${error.message}\n`);
        if (!settled) {
          settled = true;
          resolve({ accepted: false, logPath, message: error.message });
        }
        notifyExit();
      });
      child.once("exit", notifyExit);
      child.once("spawn", () => {
        settled = true;
        child.unref();
        resolve({ accepted: true, logPath, message: null });
      });
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return Promise.resolve({ accepted: false, logPath, message });
  }
}
