import * as FS from "node:fs";
import * as Path from "node:path";

const PROJECT_OPEN_FLAG = "--t3-project-path";

export function normalizePendingProjectPath(rawPath: unknown): string | null {
  if (typeof rawPath !== "string") return null;
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("-")) return null;
  const resolved = Path.resolve(trimmed);
  try {
    return FS.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function resolvePendingProjectPath(args: ReadonlyArray<string>): string | null {
  // Primary: atomic --t3-project-path=<value> format (immune to Chromium arg reordering)
  const PREFIX = `${PROJECT_OPEN_FLAG}=`;
  const equalEntry = args.find((entry) => entry.startsWith(PREFIX));
  if (equalEntry) {
    return normalizePendingProjectPath(equalEntry.slice(PREFIX.length));
  }

  // Fallback: --t3-project-path <value> (legacy / backward-compat).
  // Skip any interspersed Chromium/Electron switches (tokens starting with "-").
  const flagIndex = args.findIndex((entry) => entry === PROJECT_OPEN_FLAG);
  if (flagIndex === -1) {
    return null;
  }
  for (let i = flagIndex + 1; i < args.length; i++) {
    const candidate = args[i];
    if (candidate === undefined) break;
    if (!candidate.startsWith("-")) {
      return normalizePendingProjectPath(candidate);
    }
  }
  return null;
}
