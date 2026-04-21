import * as FS from "node:fs";
import * as Path from "node:path";

const PROJECT_PATH_FLAG_PREFIX = "--t3-project-path=";

interface ParseOptions {
  readonly isDirectory?: (candidate: string) => boolean;
  readonly realpath?: (input: string) => string;
  readonly cwd?: string;
  readonly skipLeadingPositionalArgs?: number;
}

/**
 * Find a folder path in Electron argv.
 *
 * Covers three invocation shapes that all converge here:
 *   - `T3Code /path/to/project`                    (bare positional)
 *   - `open -a "T3 Code" --args /path/to/project`  (macOS, after --args)
 *   - `T3Code --t3-project-path=/path/to/project`  (atomic escape hatch)
 *
 * Returns the resolved real path (symlinks collapsed, `..` normalized) or null.
 *
 * When Electron prefixes argv with runtime/app entry positionals, callers can
 * set `skipLeadingPositionalArgs` so those entries are not mistaken for a
 * project folder. Switches do not count toward that skip budget.
 *
 * Skips `-`-prefixed tokens so Chromium / Electron switches that land in argv —
 * especially the ones macOS injects into `second-instance.argv`, like
 * `--allow-file-access-from-files` — cannot be mistaken for a folder.
 */
export function parseFolderFromArgv(
  argv: readonly string[],
  options: ParseOptions = {},
): string | null {
  const isDirectory = options.isDirectory ?? defaultIsDirectory;
  const realpath = options.realpath ?? defaultRealpath;
  const skipLeadingPositionalArgs = options.skipLeadingPositionalArgs ?? 0;
  // Resolve relative tokens (e.g. `.` from `T3Code .`) against the invoking
  // shell's CWD. For the Electron second-instance path, the caller must pass
  // the second instance's cwd — otherwise realpath would resolve against the
  // first instance's process.cwd() and silently open the wrong folder.
  const cwd = options.cwd ?? process.cwd();

  for (const token of argv) {
    if (!token.startsWith(PROJECT_PATH_FLAG_PREFIX)) continue;
    const value = token.slice(PROJECT_PATH_FLAG_PREFIX.length);
    if (value.length === 0) continue;
    const resolved = resolveDirectory(Path.resolve(cwd, value), realpath, isDirectory);
    if (resolved) return resolved;
  }

  let skippedPositionals = 0;
  for (const token of argv) {
    if (token.length === 0 || token.startsWith("-")) continue;
    if (skippedPositionals < skipLeadingPositionalArgs) {
      skippedPositionals += 1;
      continue;
    }
    const resolved = resolveDirectory(Path.resolve(cwd, token), realpath, isDirectory);
    if (resolved) return resolved;
  }

  return null;
}

function resolveDirectory(
  candidate: string,
  realpath: (input: string) => string,
  isDirectory: (candidate: string) => boolean,
): string | null {
  try {
    const resolved = realpath(candidate);
    return isDirectory(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

function defaultIsDirectory(candidate: string): boolean {
  try {
    return FS.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function defaultRealpath(input: string): string {
  return FS.realpathSync.native(input);
}
