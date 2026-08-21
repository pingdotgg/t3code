/**
 * Worktree location - resolving where a new worktree is created.
 *
 * Projects may override the default `<baseDir>/worktrees/<repo>/<branch>`
 * layout via the `worktreeDirectoryOverrides` server setting, keyed by the
 * project's absolute workspace root.
 *
 * @module worktreeLocation
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import type { ServerSettings } from "@t3tools/contracts";

import { expandHomePath } from "../pathExpansion.ts";

/** Flatten to one directory segment, matching VS Code and the default layout. */
export function sanitizeWorktreeBranch(branch: string): string {
  return branch.replace(/\//g, "-");
}

export type WorktreeRootResolution =
  | { readonly ok: true; readonly root: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Expand and validate a configured worktree root. Relative paths are rejected
 * rather than resolved against the server's cwd, which is rarely what the user
 * meant and would scatter worktrees unpredictably.
 */
export function resolveConfiguredWorktreeRoot(raw: string): WorktreeRootResolution {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "Worktree location is empty." };
  }
  const expanded = expandHomePath(trimmed);
  if (!NodePath.isAbsolute(expanded)) {
    return {
      ok: false,
      reason: `Worktree location must be an absolute path (got "${trimmed}"). Use a full path or one starting with "~".`,
    };
  }
  return { ok: true, root: NodePath.normalize(expanded) };
}

/**
 * Look up a project's configured worktree root. Returns null when unset — the
 * caller falls back to the driver's default layout. A configured-but-invalid
 * value fails loudly instead of falling back, so worktrees never land somewhere
 * the user isn't looking.
 */
export function lookupWorktreeRoot(input: {
  readonly settings: Pick<ServerSettings, "worktreeDirectoryOverrides">;
  readonly workspaceRoot: string;
}): WorktreeRootResolution | null {
  const configured = input.settings.worktreeDirectoryOverrides[input.workspaceRoot.trim()];
  if (configured === undefined) {
    return null;
  }
  return resolveConfiguredWorktreeRoot(configured);
}

/**
 * Final worktree path under a configured root: `<root>/<branch>`. The root is
 * already per-project, so the branch sits directly inside it rather than under
 * another `<repo>` level.
 */
export function joinWorktreePath(input: {
  readonly root: string;
  readonly refName: string;
  readonly newRefName?: string | undefined;
}): string {
  const targetBranch = input.newRefName ?? input.refName;
  return NodePath.join(input.root, sanitizeWorktreeBranch(targetBranch));
}
