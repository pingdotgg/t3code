import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import type {
  GitCheckoutInput,
  GitCreateBranchInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitRemoveWorktreeInput,
  TerminalCommandInput,
  TerminalCommandResult,
} from "@t3tools/contracts";

/** Spawn git directly with an argv array — no shell, no quoting needed. */
function runGit(args: string[], cwd: string, timeoutMs = 30_000): Promise<TerminalCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
      }, 1_000).unref();
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ stdout, stderr, code: code ?? null, signal: signal ?? null, timedOut });
    });
  });
}

export async function runTerminalCommand(
  input: TerminalCommandInput,
): Promise<TerminalCommandResult> {
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
    let timedOut = false;

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
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
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

  // Resolve the real default branch from the remote
  const defaultRef = await runGit(["symbolic-ref", "refs/remotes/origin/HEAD"], input.cwd, 5_000);
  const defaultBranch =
    defaultRef.code === 0 ? defaultRef.stdout.trim().replace(/^refs\/remotes\/origin\//, "") : null;

  const branches = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => ({
      name: line.replace(/^[*+]\s+/, ""),
      current: line.startsWith("* "),
      isDefault: line.replace(/^[*+]\s+/, "") === defaultBranch,
    }))
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

  // Create a new branch from the base branch in a new worktree
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
