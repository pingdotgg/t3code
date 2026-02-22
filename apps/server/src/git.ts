import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  gitPullInputSchema,
  gitPullResultSchema,
  gitStatusInputSchema,
  gitStatusResultSchema,
  type GitCheckoutInput,
  type GitCreateBranchInput,
  type GitCreateWorktreeInput,
  type GitCreateWorktreeResult,
  type GitInitInput,
  type GitListBranchesInput,
  type GitListBranchesResult,
  type GitPullInput,
  type GitPullResult,
  type GitRemoveWorktreeInput,
  type GitStatusInput,
  type GitStatusResult,
} from "@t3tools/contracts";
import { type ProcessRunResult, runProcess } from "./processRunner";

export interface TerminalCommandInput {
  command: string;
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}



export interface GitStatusDetails extends Omit<GitStatusResult, "openPr"> {
  upstreamRef: string | null;
}

export interface GitPreparedCommitContext {
  stagedSummary: string;
  stagedPatch: string;
}

export interface GitPushResult {
  status: "pushed" | "skipped_up_to_date";
  branch: string;
  upstreamBranch?: string | undefined;
  setUpstream?: boolean | undefined;
}

export interface GitRangeContext {
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
}

interface RunGitOptions {
  timeoutMs?: number | undefined;
  allowNonZeroExit?: boolean | undefined;
}

interface ExecuteGitOptions {
  timeoutMs?: number | undefined;
  allowNonZeroExit?: boolean | undefined;
  fallbackErrorMessage?: string | undefined;
}

const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const STATUS_UPSTREAM_REFRESH_INTERVAL_MS = 15_000;
const STATUS_UPSTREAM_REFRESH_TIMEOUT_MS = 5_000;

/** Spawn git directly with an argv array — no shell, no quoting needed. */
function runGit(
  args: readonly string[],
  cwd: string,
  timeoutMs = 30_000,
): Promise<ProcessRunResult> {
  return runProcess("git", args, {
    cwd,
    timeoutMs,
    allowNonZeroExit: true,
    maxBufferBytes: DEFAULT_MAX_OUTPUT_BYTES,
    outputMode: "truncate",
  });
}

function trimStdout(value: string): string {
  return value.trim();
}

function parseBranchAb(value: string): { ahead: number; behind: number } {
  const match = value.match(/^\+(\d+)\s+-(\d+)$/);
  if (!match) return { ahead: 0, behind: 0 };
  return {
    ahead: Number(match[1] ?? "0"),
    behind: Number(match[2] ?? "0"),
  };
}

function parseNumstatEntries(
  stdout: string,
): Array<{ path: string; insertions: number; deletions: number }> {
  const entries: Array<{ path: string; insertions: number; deletions: number }> = [];
  for (const line of stdout.split(/\r?\n/g)) {
    if (line.trim().length === 0) continue;
    const [addedRaw, deletedRaw, ...pathParts] = line.split("\t");
    const rawPath =
      pathParts.length > 1 ? (pathParts.at(-1) ?? "").trim() : pathParts.join("\t").trim();
    if (rawPath.length === 0) continue;
    const added = Number.parseInt(addedRaw ?? "0", 10);
    const deleted = Number.parseInt(deletedRaw ?? "0", 10);
    const renameArrowIndex = rawPath.indexOf(" => ");
    const normalizedPath =
      renameArrowIndex >= 0 ? rawPath.slice(renameArrowIndex + " => ".length).trim() : rawPath;
    entries.push({
      path: normalizedPath.length > 0 ? normalizedPath : rawPath,
      insertions: Number.isFinite(added) ? added : 0,
      deletions: Number.isFinite(deleted) ? deleted : 0,
    });
  }
  return entries;
}

function parsePorcelainPath(line: string): string | null {
  if (line.startsWith("? ") || line.startsWith("! ")) {
    const simple = line.slice(2).trim();
    return simple.length > 0 ? simple : null;
  }

  if (!(line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u "))) {
    return null;
  }

  const tabIndex = line.indexOf("\t");
  if (tabIndex >= 0) {
    const fromTab = line.slice(tabIndex + 1);
    const [path] = fromTab.split("\t");
    return path?.trim().length ? path.trim() : null;
  }

  const parts = line.trim().split(/\s+/g);
  const path = parts.at(-1) ?? "";
  return path.length > 0 ? path : null;
}

function commandLabel(args: readonly string[]): string {
  return `git ${args.join(" ")}`;
}

function normalizeGitSpawnError(cwd: string, error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error("Failed to run git command.");
  }
  if (!fs.existsSync(cwd)) {
    return new Error(`Working directory does not exist: ${cwd}`);
  }
  if (error.message.includes("Command not found: git")) {
    return new Error("Git is required but not available on PATH.");
  }
  return new Error(`Failed to run git command: ${error.message}`);
}

function normalizeGitExecutionError(args: readonly string[], result: ProcessRunResult): Error {
  const stderr = result.stderr.trim();
  if (stderr.toLowerCase().includes("not a git repository")) {
    return new Error("Current folder is not a git repository.");
  }
  if (result.timedOut) {
    return new Error(`${commandLabel(args)} timed out.`);
  }
  const detail =
    stderr.length > 0 ? stderr : `code=${result.code ?? "null"}, signal=${result.signal ?? "null"}`;
  return new Error(`${commandLabel(args)} failed: ${detail}`);
}

async function runGitOrThrow(
  cwd: string,
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<ProcessRunResult> {
  let result: ProcessRunResult;
  try {
    result = await runGit(args, cwd, options.timeoutMs);
  } catch (error) {
    throw normalizeGitSpawnError(cwd, error);
  }

  if (result.timedOut) {
    throw normalizeGitExecutionError(args, result);
  }
  if (!options.allowNonZeroExit && result.code !== 0) {
    throw normalizeGitExecutionError(args, result);
  }
  return result;
}

async function executeGit(
  cwd: string,
  args: readonly string[],
  options: ExecuteGitOptions = {},
): Promise<ProcessRunResult> {
  const result = await runGitOrThrow(cwd, args, {
    timeoutMs: options.timeoutMs,
    allowNonZeroExit: true,
  });

  if (options.allowNonZeroExit || result.code === 0) {
    return result;
  }

  const stderr = result.stderr.trim();
  if (stderr.length > 0) {
    throw new Error(stderr);
  }
  if (options.fallbackErrorMessage) {
    throw new Error(options.fallbackErrorMessage);
  }
  throw normalizeGitExecutionError(args, result);
}

export class GitCoreService {
  private readonly lastUpstreamRefreshAt = new Map<string, number>();

  async status(raw: GitStatusInput): Promise<GitStatusResult> {
    const input = gitStatusInputSchema.parse(raw);
    const details = await this.statusDetails(input.cwd);
    return gitStatusResultSchema.parse({
      branch: details.branch,
      hasWorkingTreeChanges: details.hasWorkingTreeChanges,
      workingTree: details.workingTree,
      hasUpstream: details.hasUpstream,
      aheadCount: details.aheadCount,
      behindCount: details.behindCount,
      openPr: null,
    });
  }

  async statusDetails(cwd: string): Promise<GitStatusDetails> {
    await this.refreshStatusUpstreamIfStale(cwd).catch(() => undefined);

    const [statusStdout, unstagedNumstatStdout, stagedNumstatStdout] = await Promise.all([
      this.gitStdout(cwd, ["status", "--porcelain=2", "--branch"]),
      this.gitStdout(cwd, ["diff", "--numstat"]),
      this.gitStdout(cwd, ["diff", "--cached", "--numstat"]),
    ]);

    let branch: string | null = null;
    let upstreamRef: string | null = null;
    let aheadCount = 0;
    let behindCount = 0;
    let hasWorkingTreeChanges = false;
    const changedFilesWithoutNumstat = new Set<string>();

    for (const line of statusStdout.split(/\r?\n/g)) {
      if (line.startsWith("# branch.head ")) {
        const value = line.slice("# branch.head ".length).trim();
        branch = value.startsWith("(") ? null : value;
        continue;
      }
      if (line.startsWith("# branch.upstream ")) {
        const value = line.slice("# branch.upstream ".length).trim();
        upstreamRef = value.length > 0 ? value : null;
        continue;
      }
      if (line.startsWith("# branch.ab ")) {
        const value = line.slice("# branch.ab ".length).trim();
        const parsed = parseBranchAb(value);
        aheadCount = parsed.ahead;
        behindCount = parsed.behind;
        continue;
      }
      if (line.trim().length > 0 && !line.startsWith("#")) {
        hasWorkingTreeChanges = true;
        const pathValue = parsePorcelainPath(line);
        if (pathValue) changedFilesWithoutNumstat.add(pathValue);
      }
    }
    const stagedEntries = parseNumstatEntries(stagedNumstatStdout);
    const unstagedEntries = parseNumstatEntries(unstagedNumstatStdout);
    const fileStatMap = new Map<string, { insertions: number; deletions: number }>();
    for (const entry of [...stagedEntries, ...unstagedEntries]) {
      const existing = fileStatMap.get(entry.path) ?? { insertions: 0, deletions: 0 };
      existing.insertions += entry.insertions;
      existing.deletions += entry.deletions;
      fileStatMap.set(entry.path, existing);
    }

    let insertions = 0;
    let deletions = 0;
    const files = Array.from(fileStatMap.entries())
      .map(([path, stat]) => {
        insertions += stat.insertions;
        deletions += stat.deletions;
        return { path, insertions: stat.insertions, deletions: stat.deletions };
      })
      .toSorted((a, b) => a.path.localeCompare(b.path));

    for (const filePath of changedFilesWithoutNumstat) {
      if (fileStatMap.has(filePath)) continue;
      files.push({ path: filePath, insertions: 0, deletions: 0 });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));

    return {
      branch,
      upstreamRef,
      hasWorkingTreeChanges,
      workingTree: {
        files,
        insertions,
        deletions,
      },
      hasUpstream: upstreamRef !== null,
      aheadCount,
      behindCount,
    };
  }

  async prepareCommitContext(cwd: string): Promise<GitPreparedCommitContext | null> {
    await this.git(cwd, ["add", "-A"]);

    const stagedSummary = await this.gitStdout(cwd, ["diff", "--cached", "--name-status"]);
    if (trimStdout(stagedSummary).length === 0) {
      return null;
    }

    const stagedPatch = await this.gitStdout(cwd, ["diff", "--cached", "--patch", "--minimal"]);

    return {
      stagedSummary,
      stagedPatch,
    };
  }

  async commit(cwd: string, subject: string, body: string): Promise<{ commitSha: string }> {
    const args = ["commit", "-m", subject];
    const trimmedBody = body.trim();
    if (trimmedBody.length > 0) {
      args.push("-m", trimmedBody);
    }
    await this.git(cwd, args);
    const commitSha = trimStdout(await this.gitStdout(cwd, ["rev-parse", "HEAD"]));
    return { commitSha };
  }

  async pushCurrentBranch(cwd: string, fallbackBranch: string | null): Promise<GitPushResult> {
    const details = await this.statusDetails(cwd);
    const branch = details.branch ?? fallbackBranch;
    if (!branch) {
      throw new Error("Cannot push from detached HEAD.");
    }

    if (details.hasUpstream && details.aheadCount === 0 && details.behindCount === 0) {
      return {
        status: "skipped_up_to_date",
        branch,
        ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
      };
    }

    if (!details.hasUpstream) {
      await this.git(cwd, ["push", "-u", "origin", branch]);
      return {
        status: "pushed",
        branch,
        upstreamBranch: `origin/${branch}`,
        setUpstream: true,
      };
    }

    await this.git(cwd, ["push"]);
    return {
      status: "pushed",
      branch,
      ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
      setUpstream: false,
    };
  }

  async pullCurrentBranch(cwd: string): Promise<GitPullResult> {
    const details = await this.statusDetails(cwd);
    const branch = details.branch;
    if (!branch) {
      throw new Error("Cannot pull from detached HEAD.");
    }
    if (!details.hasUpstream) {
      throw new Error("Current branch has no upstream configured. Push with upstream first.");
    }
    const beforeSha = trimStdout(await this.gitStdout(cwd, ["rev-parse", "HEAD"], true));
    await executeGit(cwd, ["pull", "--ff-only"], {
      timeoutMs: 30_000,
      fallbackErrorMessage: "git pull failed",
    });
    const afterSha = trimStdout(await this.gitStdout(cwd, ["rev-parse", "HEAD"], true));
    const refreshed = await this.statusDetails(cwd);
    return gitPullResultSchema.parse({
      status: beforeSha.length > 0 && beforeSha === afterSha ? "skipped_up_to_date" : "pulled",
      branch,
      ...(refreshed.upstreamRef ? { upstreamBranch: refreshed.upstreamRef } : {}),
    });
  }

  async readRangeContext(cwd: string, baseBranch: string): Promise<GitRangeContext> {
    const range = `${baseBranch}..HEAD`;
    const [commitSummary, diffSummary, diffPatch] = await Promise.all([
      this.gitStdout(cwd, ["log", "--oneline", range]),
      this.gitStdout(cwd, ["diff", "--stat", range]),
      this.gitStdout(cwd, ["diff", "--patch", "--minimal", range]),
    ]);

    return {
      commitSummary,
      diffSummary,
      diffPatch,
    };
  }

  async readConfigValue(cwd: string, key: string): Promise<string | null> {
    const stdout = await this.gitStdout(cwd, ["config", "--get", key], true);
    const value = trimStdout(stdout);
    return value.length > 0 ? value : null;
  }

  private async readBranchRecency(cwd: string): Promise<Map<string, number>> {
    const branchRecency = await executeGit(
      cwd,
      ["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"],
      {
        timeoutMs: 15_000,
        allowNonZeroExit: true,
      },
    );

    const branchLastCommit = new Map<string, number>();
    if (branchRecency.code !== 0) {
      return branchLastCommit;
    }

    for (const line of branchRecency.stdout.split("\n")) {
      if (line.length === 0) {
        continue;
      }
      const [name, lastCommitRaw] = line.split("\t");
      if (!name) {
        continue;
      }
      const lastCommit = Number.parseInt(lastCommitRaw ?? "0", 10);
      branchLastCommit.set(name, Number.isFinite(lastCommit) ? lastCommit : 0);
    }

    return branchLastCommit;
  }

  async listBranches(input: GitListBranchesInput): Promise<GitListBranchesResult> {
    const branchRecencyPromise = this.readBranchRecency(input.cwd).catch(
      () => new Map<string, number>(),
    );
    const result = await executeGit(input.cwd, ["branch", "--no-color"], {
      timeoutMs: 10_000,
      allowNonZeroExit: true,
    });

    if (result.code !== 0) {
      const stderr = result.stderr.trim();
      if (stderr.toLowerCase().includes("not a git repository")) {
        return { branches: [], isRepo: false };
      }
      throw new Error(stderr || "git branch failed");
    }

    const [defaultRef, worktreeList, branchLastCommit] = await Promise.all([
      executeGit(input.cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"], {
        timeoutMs: 5_000,
        allowNonZeroExit: true,
      }),
      executeGit(input.cwd, ["worktree", "list", "--porcelain"], {
        timeoutMs: 5_000,
        allowNonZeroExit: true,
      }),
      branchRecencyPromise,
    ]);
    const defaultBranch =
      defaultRef.code === 0
        ? defaultRef.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
        : null;

    const worktreeMap = new Map<string, string>();
    if (worktreeList.code === 0) {
      let currentPath: string | null = null;
      for (const line of worktreeList.stdout.split("\n")) {
        if (line.startsWith("worktree ")) {
          const candidatePath = line.slice("worktree ".length);
          currentPath = fs.existsSync(candidatePath) ? candidatePath : null;
        } else if (line.startsWith("branch refs/heads/") && currentPath) {
          worktreeMap.set(line.slice("branch refs/heads/".length), currentPath);
        } else if (line === "") {
          currentPath = null;
        }
      }
    }

    const branches = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const name = line.replace(/^[*+]\s+/, "");
        return {
          name,
          current: line.startsWith("* "),
          isDefault: name === defaultBranch,
          worktreePath: worktreeMap.get(name) ?? null,
        };
      })
      .toSorted((a, b) => {
        const aPriority = a.current ? 0 : a.isDefault ? 1 : 2;
        const bPriority = b.current ? 0 : b.isDefault ? 1 : 2;
        if (aPriority !== bPriority) return aPriority - bPriority;

        const aLastCommit = branchLastCommit.get(a.name) ?? 0;
        const bLastCommit = branchLastCommit.get(b.name) ?? 0;
        if (aLastCommit !== bLastCommit) return bLastCommit - aLastCommit;
        return a.name.localeCompare(b.name);
      });

    return { branches, isRepo: true };
  }

  async createWorktree(input: GitCreateWorktreeInput): Promise<GitCreateWorktreeResult> {
    const sanitizedBranch = input.newBranch.replace(/\//g, "-");
    const repoName = path.basename(input.cwd);
    const worktreePath =
      input.path ?? path.join(os.homedir(), ".t3", "worktrees", repoName, sanitizedBranch);

    await executeGit(
      input.cwd,
      ["worktree", "add", "-b", input.newBranch, worktreePath, input.branch],
      { fallbackErrorMessage: "git worktree add failed" },
    );

    return {
      worktree: {
        path: worktreePath,
        branch: input.newBranch,
      },
    };
  }

  async removeWorktree(input: GitRemoveWorktreeInput): Promise<void> {
    const args = ["worktree", "remove"];
    if (input.force) {
      args.push("--force");
    }
    args.push(input.path);
    try {
      await executeGit(input.cwd, args, {
        timeoutMs: 15_000,
        fallbackErrorMessage: "git worktree remove failed",
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${commandLabel(args)} failed (cwd: ${input.cwd}): ${detail}`, {
        cause: error,
      });
    }
  }

  async createBranch(input: GitCreateBranchInput): Promise<void> {
    await executeGit(input.cwd, ["branch", input.branch], {
      timeoutMs: 10_000,
      fallbackErrorMessage: "git branch create failed",
    });
  }

  private async resolveCurrentUpstream(
    cwd: string,
  ): Promise<{ upstreamRef: string; remoteName: string; upstreamBranch: string } | null> {
    const upstreamRef = trimStdout(
      await this.gitStdout(
        cwd,
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        true,
      ),
    );
    if (upstreamRef.length === 0 || upstreamRef === "@{upstream}") {
      return null;
    }

    const separatorIndex = upstreamRef.indexOf("/");
    if (separatorIndex <= 0) {
      return null;
    }
    const remoteName = upstreamRef.slice(0, separatorIndex);
    const upstreamBranch = upstreamRef.slice(separatorIndex + 1);
    if (remoteName.length === 0) {
      return null;
    }
    if (upstreamBranch.length === 0) {
      return null;
    }

    return {
      upstreamRef,
      remoteName,
      upstreamBranch,
    };
  }

  private async fetchUpstreamRef(
    cwd: string,
    upstream: { upstreamRef: string; remoteName: string; upstreamBranch: string },
  ): Promise<void> {
    const refspec = `+refs/heads/${upstream.upstreamBranch}:refs/remotes/${upstream.upstreamRef}`;
    await this.git(cwd, ["fetch", "--quiet", "--no-tags", upstream.remoteName, refspec], true);
  }

  private async fetchUpstreamRefForStatus(
    cwd: string,
    upstream: { upstreamRef: string; remoteName: string; upstreamBranch: string },
  ): Promise<void> {
    const refspec = `+refs/heads/${upstream.upstreamBranch}:refs/remotes/${upstream.upstreamRef}`;
    await executeGit(cwd, ["fetch", "--quiet", "--no-tags", upstream.remoteName, refspec], {
      allowNonZeroExit: true,
      timeoutMs: STATUS_UPSTREAM_REFRESH_TIMEOUT_MS,
    });
  }

  private async refreshStatusUpstreamIfStale(cwd: string): Promise<void> {
    const upstream = await this.resolveCurrentUpstream(cwd);
    if (!upstream) {
      return;
    }

    const cacheKey = `${cwd}\u0000${upstream.upstreamRef}`;
    const now = Date.now();
    const lastRefreshAt = this.lastUpstreamRefreshAt.get(cacheKey) ?? 0;
    if (now - lastRefreshAt < STATUS_UPSTREAM_REFRESH_INTERVAL_MS) {
      return;
    }

    // Record attempt time first to avoid repeated fetch spikes when status is polled often.
    this.lastUpstreamRefreshAt.set(cacheKey, now);
    await this.fetchUpstreamRefForStatus(cwd, upstream);
  }

  private async refreshCheckedOutBranchUpstream(cwd: string): Promise<void> {
    const upstream = await this.resolveCurrentUpstream(cwd);
    if (!upstream) {
      return;
    }
    await this.fetchUpstreamRef(cwd, upstream);
  }

  async checkoutBranch(input: GitCheckoutInput): Promise<void> {
    await executeGit(input.cwd, ["checkout", input.branch], {
      timeoutMs: 10_000,
      fallbackErrorMessage: "git checkout failed",
    });
    // Refresh upstream refs in the background so checkout remains responsive.
    void this.refreshCheckedOutBranchUpstream(input.cwd).catch(() => undefined);
  }

  async initRepo(input: GitInitInput): Promise<void> {
    await executeGit(input.cwd, ["init"], {
      timeoutMs: 10_000,
      fallbackErrorMessage: "git init failed",
    });
  }

  async git(cwd: string, args: readonly string[], allowNonZeroExit = false): Promise<void> {
    await executeGit(cwd, args, { allowNonZeroExit });
  }

  async gitStdout(cwd: string, args: readonly string[], allowNonZeroExit = false): Promise<string> {
    const result = await executeGit(cwd, args, { allowNonZeroExit });
    return result.stdout;
  }
}

const defaultGitCoreService = new GitCoreService();

export async function runTerminalCommand(
  input: TerminalCommandInput,
): Promise<ProcessRunResult> {
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const shellPath =
    process.platform === "win32"
      ? (process.env.ComSpec ?? "cmd.exe")
      : (process.env.SHELL ?? "/bin/sh");

  const args =
    process.platform === "win32" ? ["/d", "/s", "/c", input.command] : ["-lc", input.command];

  const result = await runProcess(shellPath, args, {
    cwd: input.cwd,
    timeoutMs: input.timeoutMs ?? 30_000,
    allowNonZeroExit: true,
    maxBufferBytes: maxOutputBytes,
    outputMode: "truncate",
  });

  if (!result.stdoutTruncated && !result.stderrTruncated) {
    return result;
  }

  return {
    ...result,
    stderr: `${result.stderr}\n[output truncated at ${maxOutputBytes} bytes]`,
  };
}

export async function listGitBranches(input: GitListBranchesInput): Promise<GitListBranchesResult> {
  return defaultGitCoreService.listBranches(input);
}

export async function pullGitBranch(raw: GitPullInput): Promise<GitPullResult> {
  const input = gitPullInputSchema.parse(raw);
  return defaultGitCoreService.pullCurrentBranch(input.cwd);
}

export async function createGitWorktree(
  input: GitCreateWorktreeInput,
): Promise<GitCreateWorktreeResult> {
  return defaultGitCoreService.createWorktree(input);
}

export async function removeGitWorktree(input: GitRemoveWorktreeInput): Promise<void> {
  await defaultGitCoreService.removeWorktree(input);
}

export async function createGitBranch(input: GitCreateBranchInput): Promise<void> {
  await defaultGitCoreService.createBranch(input);
}

export async function checkoutGitBranch(input: GitCheckoutInput): Promise<void> {
  await defaultGitCoreService.checkoutBranch(input);
}

export async function initGitRepo(input: GitInitInput): Promise<void> {
  await defaultGitCoreService.initRepo(input);
}
