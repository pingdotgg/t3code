import type * as Path from "effect/Path";

import { expandHomePathWith } from "./pathExpansion.ts";

/**
 * Directory new worktrees are created under: the `worktreesDirectory`
 * setting, or `defaultDir` (`<T3 home>/worktrees`) when it is empty. Null when
 * the setting is not an absolute path on this machine, such as `D:\worktrees`
 * configured for a Windows server and synced to a Linux one.
 */
export function resolveWorktreesDirectory(
  setting: string,
  defaultDir: string,
  path: Path.Path,
): string | null {
  if (setting === "") return defaultDir;
  const expanded = expandHomePathWith(setting, path);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : null;
}

/** Every directory that holds T3-managed worktrees on this machine. */
export function managedWorktreesDirectories(
  setting: string,
  defaultDir: string,
  path: Path.Path,
): ReadonlyArray<string> {
  const custom = resolveWorktreesDirectory(setting, defaultDir, path);
  return custom === null || custom === defaultDir ? [defaultDir] : [defaultDir, custom];
}
