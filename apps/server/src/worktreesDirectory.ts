import type * as Path from "effect/Path";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

/** Null for filesystem roots or settings not absolute on this host, including synced foreign-platform paths. */
export function resolveWorktreesDirectory(
  setting: string,
  defaultDir: string,
  path: Path.Path,
  home: string,
): string | null {
  if (setting === "") return defaultDir;
  const expanded = expandHomePath(setting, home);
  if (!path.isAbsolute(expanded)) return null;
  const resolved = path.resolve(expanded);
  return isFilesystemRoot(resolved, path) ? null : resolved;
}

// Characters Windows forbids in names, so a setting synced between hosts means the same folders.
const UNPORTABLE_CHARACTERS = /[\p{Cc}<>:"|?*]/u;
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** True for names Git or Windows treat as the repository directory, including the NTFS short name. */
export function isGitDirectoryName(segment: string): boolean {
  return /^(\.git|git~\d+)[. ]*$/i.test(segment);
}

/**
 * Folders below each repository's main checkout, or null when the setting is empty, absolute,
 * home-relative, or unsafe. Both separators split, so foreign-platform roots never pass as relative.
 */
export function parseRelativeWorktreesDirectory(setting: string): ReadonlyArray<string> | null {
  if (
    setting === "" ||
    setting.startsWith("~") ||
    /^[\\/]/.test(setting) ||
    UNPORTABLE_CHARACTERS.test(setting)
  ) {
    return null;
  }
  const segments = setting.split(/[\\/]+/).filter((segment) => segment !== "");
  const safe = segments.every(
    (segment) =>
      // Windows drops trailing dots and spaces, which also covers "." and "..".
      !/[. ]$/.test(segment) && !isGitDirectoryName(segment) && !WINDOWS_DEVICE_NAME.test(segment),
  );
  return segments.length > 0 && safe ? segments : null;
}

/** Callers re-check after resolving symlinks: a link can point at a root. */
export function isFilesystemRoot(directory: string, path: Path.Path): boolean {
  return path.dirname(directory) === directory;
}

export function managedWorktreesDirectories(
  settings: {
    readonly worktreesDirectory: string;
    readonly previousWorktreesDirectories: ReadonlyArray<string>;
  },
  defaultDir: string,
  path: Path.Path,
  home: string,
): ReadonlyArray<string> {
  const directories = new Set([defaultDir]);
  for (const setting of [settings.worktreesDirectory, ...settings.previousWorktreesDirectories]) {
    const directory = resolveWorktreesDirectory(setting, defaultDir, path, home);
    if (directory !== null) directories.add(directory);
  }
  return [...directories];
}
