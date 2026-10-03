import { realpath } from "node:fs/promises";
import path from "node:path";

import { runProcess } from "../processRunner.ts";

export async function canonicalizeWorktreePath(worktreePath: string): Promise<string> {
  const resolved = path.resolve(worktreePath);
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

async function readGitWorktreeRoot(canonicalPath: string): Promise<string | null> {
  try {
    const result = await runProcess("git", ["-C", canonicalPath, "rev-parse", "--show-toplevel"], {
      allowNonZeroExit: true,
      maxBufferBytes: 16 * 1024,
      timeoutMs: 5_000,
    });
    if (result.code !== 0) return null;

    const root = result.stdout.trim();
    return root.length === 0 ? null : await canonicalizeWorktreePath(root);
  } catch {
    return null;
  }
}

export interface GitWorktreeIdentity {
  /** Canonical path of the requested location. */
  readonly canonicalPath: string;
  /** Canonical Git top level for it, or null when it is not inside a worktree. */
  readonly gitRoot: string | null;
}

/**
 * Canonicalizes `worktreePath` and reports its Git top level from one pass.
 *
 * Workspace admission needs both values for the same path, and reaching them
 * separately canonicalizes the path twice before running `git rev-parse` once.
 * Resolving them together lets a caller that already holds an identity reuse it
 * instead of re-deriving it for the same decision.
 *
 * Nothing is cached across decisions. Identity has to stay authoritative: a
 * checkout that was removed, recreated, or handed to another thread must be
 * re-read from Git, and a memo keyed on a path cannot tell a replaced checkout
 * from the one it replaced. Cache invalidation on every cleanup, recreation, and
 * handoff would leave a stale-identity window open, so the only reuse here is
 * within a single admission.
 */
export async function resolveGitWorktreeIdentity(
  worktreePath: string,
): Promise<GitWorktreeIdentity> {
  const canonicalPath = await canonicalizeWorktreePath(worktreePath);
  return { canonicalPath, gitRoot: await readGitWorktreeRoot(canonicalPath) };
}

export async function resolveGitWorktreeRoot(worktreePath: string): Promise<string | null> {
  return (await resolveGitWorktreeIdentity(worktreePath)).gitRoot;
}
