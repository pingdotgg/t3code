import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  gitStatusInputSchema,
  gitStatusResultSchema,
  type GitCheckoutInput,
  type GitCreateBranchInput,
  type GitCreateWorktreeInput,
  type GitCreateWorktreeResult,
  type GitInitInput,
  type GitListBranchesInput,
  type GitListBranchesResult,
  type GitRemoveWorktreeInput,
  type GitStatusInput,
  type GitStatusResult,
} from "@t3tools/contracts";

export interface TerminalCommandInput {
  command: string;
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface TerminalCommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export interface GitStatusDetails extends GitStatusResult {
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

const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;

function appendChunkWithinLimit(
  target: string,
  currentBytes: number,
  chunk: Buffer,
  maxBytes: number,
): {
  next: string;
  nextBytes: number;
  truncated: boolean;
} {
  const remaining = maxBytes - currentBytes;
  if (remaining <= 0) {
    return { next: target, nextBytes: currentBytes, truncated: true };
  }
  if (chunk.length <= remaining) {
    return {
      next: `${target}${chunk.toString()}`,
      nextBytes: currentBytes + chunk.length,
      truncated: false,
    };
  }
  return {
    next: `${target}${chunk.subarray(0, remaining).toString()}`,
    nextBytes: currentBytes + remaining,
    truncated: true,
  };
}

/** Spawn git directly with an argv array — no shell, no quoting needed. */
function runGit(args: readonly string[], cwd: string, timeoutMs = 30_000): Promise<TerminalCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputTruncated = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 1_000).unref();
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      const appended = appendChunkWithinLimit(stdout, stdoutBytes, chunk, maxOutputBytes);
      stdout = appended.next;
      stdoutBytes = appended.nextBytes;
      outputTruncated = outputTruncated || appended.truncated;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const appended = appendChunkWithinLimit(stderr, stderrBytes, chunk, maxOutputBytes);
      stderr = appended.next;
      stderrBytes = appended.nextBytes;
      outputTruncated = outputTruncated || appended.truncated;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (outputTruncated) {
        stderr = `${stderr}\n[output truncated at ${maxOutputBytes} bytes]`;
      }
      resolve({ stdout, stderr, code: code ?? null, signal: signal ?? null, timedOut });
    });
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

function commandLabel(args: readonly string[]): string {
  return `git ${args.join(" ")}`;
}

function normalizeGitSpawnError(cwd: string, error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error("Failed to run git command.");
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    if (!fs.existsSync(cwd)) {
      return new Error(`Working directory does not exist: ${cwd}`);
    }
    return new Error("Git is required but not available on PATH.");
  }
  return new Error(`Failed to run git command: ${error.message}`);
}

function normalizeGitExecutionError(args: readonly string[], result: TerminalCommandResult): Error {
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
): Promise<TerminalCommandResult> {
  let result: TerminalCommandResult;
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

export class GitCoreService {
  async status(raw: GitStatusInput): Promise<GitStatusResult> {
    const input = gitStatusInputSchema.parse(raw);
    const details = await this.statusDetails(input.cwd);
    return gitStatusResultSchema.parse({
      branch: details.branch,
      hasWorkingTreeChanges: details.hasWorkingTreeChanges,
      hasUpstream: details.hasUpstream,
      aheadCount: details.aheadCount,
      behindCount: details.behindCount,
    });
  }

  async statusDetails(cwd: string): Promise<GitStatusDetails> {
    const stdout = await this.gitStdout(cwd, ["status", "--porcelain=2", "--branch"]);

    let branch: string | null = null;
    let upstreamRef: string | null = null;
    let aheadCount = 0;
    let behindCount = 0;
    let hasWorkingTreeChanges = false;

    for (const line of stdout.split(/\r?\n/g)) {
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
      }
    }

    return {
      branch,
      upstreamRef,
      hasWorkingTreeChanges,
      hasUpstream: upstreamRef !== null,
      aheadCount,
      behindCount,
    };
  }

  async prepareCommitContext(cwd: string): Promise<GitPreparedCommitContext | null> {
    await this.git(cwd, ["add", "-A"]);

    const stagedSummary = await this.gitStdout(cwd, [
      "diff",
      "--cached",
      "--name-status",
    ]);
    if (trimStdout(stagedSummary).length === 0) {
      return null;
    }

    const stagedPatch = await this.gitStdout(cwd, [
      "diff",
      "--cached",
      "--patch",
      "--minimal",
    ]);

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

  async git(cwd: string, args: readonly string[], allowNonZeroExit = false): Promise<void> {
    await runGitOrThrow(cwd, args, { allowNonZeroExit });
  }

  async gitStdout(cwd: string, args: readonly string[], allowNonZeroExit = false): Promise<string> {
    const result = await runGitOrThrow(cwd, args, { allowNonZeroExit });
    return result.stdout;
  }
}

export async function runTerminalCommand(
  input: TerminalCommandInput,
): Promise<TerminalCommandResult> {
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const shellPath =
    process.platform === "win32"
      ? (process.env.ComSpec ?? "cmd.exe")
      : (process.env.SHELL ?? "/bin/sh");

  const args =
    process.platform === "win32" ? ["/d", "/s", "/c", input.command] : ["-lc", input.command];

  return new Promise((resolve, reject) => {
    const child = spawn(shellPath, args, {
      cwd: input.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputTruncated = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 1_000).unref();
    }, input.timeoutMs ?? 30_000);

    child.stdout?.on("data", (chunk: Buffer) => {
      const appended = appendChunkWithinLimit(stdout, stdoutBytes, chunk, maxOutputBytes);
      stdout = appended.next;
      stdoutBytes = appended.nextBytes;
      outputTruncated = outputTruncated || appended.truncated;
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const appended = appendChunkWithinLimit(stderr, stderrBytes, chunk, maxOutputBytes);
      stderr = appended.next;
      stderrBytes = appended.nextBytes;
      outputTruncated = outputTruncated || appended.truncated;
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (outputTruncated) {
        stderr = `${stderr}\n[output truncated at ${maxOutputBytes} bytes]`;
      }
      resolve({
        stdout,
        stderr,
        code: code ?? null,
        signal: signal ?? null,
        timedOut,
      });
    });
  });
}

export async function listGitBranches(input: GitListBranchesInput): Promise<GitListBranchesResult> {
  const result = await runGit(["branch", "--no-color"], input.cwd, 10_000);

  if (result.code !== 0) {
    const stderr = result.stderr.trim();
    if (stderr.includes("not a git repository")) {
      return { branches: [], isRepo: false };
    }
    throw new Error(stderr || "git branch failed");
  }

  const [defaultRef, worktreeList] = await Promise.all([
    runGit(["symbolic-ref", "refs/remotes/origin/HEAD"], input.cwd, 5_000),
    runGit(["worktree", "list", "--porcelain"], input.cwd, 5_000),
  ]);
  const defaultBranch =
    defaultRef.code === 0 ? defaultRef.stdout.trim().replace(/^refs\/remotes\/origin\//, "") : null;

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
      if (a.current !== b.current) return a.current ? -1 : 1;
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  return { branches, isRepo: true };
}

export async function createGitWorktree(
  input: GitCreateWorktreeInput,
): Promise<GitCreateWorktreeResult> {
  const sanitizedBranch = input.newBranch.replace(/\//g, "-");
  const repoName = path.basename(input.cwd);
  const worktreePath =
    input.path ?? path.join(os.homedir(), ".t3", "worktrees", repoName, sanitizedBranch);

  const result = await runGit(
    ["worktree", "add", "-b", input.newBranch, worktreePath, input.branch],
    input.cwd,
  );

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "git worktree add failed");
  }

  return {
    worktree: {
      path: worktreePath,
      branch: input.newBranch,
    },
  };
}

export async function removeGitWorktree(input: GitRemoveWorktreeInput): Promise<void> {
  const result = await runGit(["worktree", "remove", input.path], input.cwd, 15_000);

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "git worktree remove failed");
  }
}

export async function createGitBranch(input: GitCreateBranchInput): Promise<void> {
  const result = await runGit(["branch", input.branch], input.cwd, 10_000);

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "git branch create failed");
  }
}

export async function checkoutGitBranch(input: GitCheckoutInput): Promise<void> {
  const result = await runGit(["checkout", input.branch], input.cwd, 10_000);

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "git checkout failed");
  }
}

export async function initGitRepo(input: GitInitInput): Promise<void> {
  const result = await runGit(["init"], input.cwd, 10_000);

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "git init failed");
  }
}
