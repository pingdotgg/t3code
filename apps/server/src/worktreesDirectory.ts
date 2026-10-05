import type * as Path from "effect/Path";

import { expandHomePathWith } from "./pathExpansion.ts";

/**
 * Directory new worktrees are created under: the `worktreesDirectory`
 * setting, or `defaultDir` (`<T3 home>/worktrees`) when it is empty. Null when
 * the setting is not an absolute path on this machine, such as `D:\worktrees`
 * configured for a Windows server and synced to a Linux one, or when it is a
 * filesystem root, which would make every path on that drive look managed.
 */
export function resolveWorktreesDirectory(
  setting: string,
  defaultDir: string,
  path: Path.Path,
): string | null {
  if (setting === "") return defaultDir;
  const expanded = expandHomePathWith(setting, path);
  if (!path.isAbsolute(expanded)) return null;
  const resolved = path.resolve(expanded);
  return path.dirname(resolved) === resolved ? null : resolved;
}

/** Every directory that holds T3-managed worktrees on this machine. */
export function managedWorktreesDirectories(
  settings: {
    readonly worktreesDirectory: string;
    readonly previousWorktreesDirectories: ReadonlyArray<string>;
  },
  defaultDir: string,
  path: Path.Path,
): ReadonlyArray<string> {
  const directories = new Set([defaultDir]);
  for (const setting of [settings.worktreesDirectory, ...settings.previousWorktreesDirectories]) {
    const directory = resolveWorktreesDirectory(setting, defaultDir, path);
    if (directory !== null) directories.add(directory);
  }
  return [...directories];
}
