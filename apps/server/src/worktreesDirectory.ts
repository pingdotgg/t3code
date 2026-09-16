import type * as Path from "effect/Path";

import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

import { expandHomePathWith } from "./pathExpansion.ts";

/**
 * Resolve the directory T3 should create new git worktrees under.
 * Empty (the setting default) keeps `<T3 home>/worktrees`. Otherwise expand
 * a leading `~` and resolve against the process cwd so a drive path like
 * `D:\dev\t3\worktrees` just works.
 */
export const resolveWorktreesDirectory = (
  configured: string,
  defaultWorktreesDir: string,
  path: Path.Path,
): string => {
  const trimmed = configured.trim();
  if (trimmed.length === 0) return path.resolve(defaultWorktreesDir);
  return path.resolve(expandHomePathWith(trimmed, path));
};

/**
 * Roots that still count as T3-managed after the setting changes.
 * Existing threads keep their absolute paths, so the previous default
 * must stay recognized alongside a newly configured directory.
 */
export const listManagedWorktreesRoots = (
  configured: string,
  defaultWorktreesDir: string,
  path: Path.Path,
): ReadonlyArray<string> => {
  const defaultRoot = path.resolve(defaultWorktreesDir);
  const resolved = resolveWorktreesDirectory(configured, defaultWorktreesDir, path);
  if (
    normalizeProjectPathForComparison(resolved) === normalizeProjectPathForComparison(defaultRoot)
  ) {
    return [resolved];
  }
  return [resolved, defaultRoot];
};
