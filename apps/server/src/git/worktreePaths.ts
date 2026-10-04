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
 * Both values from one pass, so admission stops canonicalizing the path twice.
 * Deliberately not cached across decisions: a memo keyed on a path cannot tell a
 * replaced checkout from the one it replaced.
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
