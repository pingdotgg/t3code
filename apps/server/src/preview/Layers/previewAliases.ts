import path from "node:path";

export interface AliasEntry {
  readonly find: string;
  readonly replacement: string;
}

interface AliasResolutionOptions {
  readonly configDir: string;
  readonly baseUrl?: string;
}

function trimAliasPattern(pattern: string): string | null {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (!trimmed.includes("*")) {
    return trimmed;
  }
  if (trimmed.endsWith("/*")) {
    return trimmed.slice(0, -2);
  }
  if (trimmed.endsWith("*")) {
    return trimmed.slice(0, -1).replace(/\/$/, "");
  }
  return null;
}

function resolveTargetPath(targetPattern: string, options: AliasResolutionOptions): string | null {
  const normalizedTarget = trimAliasPattern(targetPattern);
  if (!normalizedTarget) {
    return null;
  }

  if (path.isAbsolute(normalizedTarget)) {
    return path.normalize(normalizedTarget);
  }

  const baseDir = options.baseUrl?.trim()
    ? path.resolve(options.configDir, options.baseUrl)
    : options.configDir;
  return path.resolve(baseDir, normalizedTarget);
}

export function aliasEntriesFromTsconfigPaths(
  pathsRecord: Record<string, readonly string[]> | undefined,
  options: AliasResolutionOptions,
): readonly AliasEntry[] {
  if (!pathsRecord) {
    return [];
  }

  const aliasEntries: AliasEntry[] = [];

  for (const [findPattern, targets] of Object.entries(pathsRecord)) {
    const find = trimAliasPattern(findPattern);
    if (!find) {
      continue;
    }

    const replacement = targets
      .map((target) => resolveTargetPath(target, options))
      .find((candidate) => candidate !== null);
    if (!replacement) {
      continue;
    }

    aliasEntries.push({ find, replacement });
  }

  return aliasEntries;
}
