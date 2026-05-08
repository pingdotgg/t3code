import type { ProjectEntry, ProjectListEntriesResult } from "@forma/contracts";

export function compareProjectEntries(left: ProjectEntry, right: ProjectEntry): number {
  if (left.kind !== right.kind) {
    return left.kind === "directory" ? -1 : 1;
  }

  return left.path.localeCompare(right.path, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function sortProjectEntries(entries: readonly ProjectEntry[]): ProjectEntry[] {
  return [...entries].sort(compareProjectEntries);
}

export function parentPathForRelativePath(pathValue: string): string | null {
  const normalizedPath = pathValue.replaceAll("\\", "/");
  const separatorIndex = normalizedPath.lastIndexOf("/");
  if (separatorIndex === -1) {
    return null;
  }
  return normalizedPath.slice(0, separatorIndex);
}

export function createProjectEntry(path: string, kind: ProjectEntry["kind"]): ProjectEntry {
  const parentPath = parentPathForRelativePath(path);
  return {
    path,
    kind,
    ...(parentPath !== null ? { parentPath } : {}),
  };
}

export function upsertProjectListEntry(
  current: ProjectListEntriesResult | undefined,
  entry: ProjectEntry,
): ProjectListEntriesResult {
  const nextEntries = sortProjectEntries([
    ...(current?.entries ?? []).filter((candidate) => candidate.path !== entry.path),
    entry,
  ]);
  return { entries: nextEntries };
}

export function removeProjectListEntry(
  current: ProjectListEntriesResult | undefined,
  path: string,
): ProjectListEntriesResult {
  return {
    entries: (current?.entries ?? []).filter((candidate) => candidate.path !== path),
  };
}

export function renameProjectListEntry(
  current: ProjectListEntriesResult | undefined,
  input: { fromPath: string; toEntry: ProjectEntry },
): ProjectListEntriesResult {
  return upsertProjectListEntry(removeProjectListEntry(current, input.fromPath), input.toEntry);
}

export function pathEqualsOrContainsParent(pathValue: string, candidatePath: string): boolean {
  return candidatePath === pathValue || candidatePath.startsWith(`${pathValue}/`);
}

export function replaceExpandedDirectoryPrefix(
  paths: ReadonlySet<string>,
  input: { fromPrefix: string; toPrefix: string | null },
): ReadonlySet<string> {
  const nextPaths = new Set<string>();

  for (const pathValue of paths) {
    if (pathValue === input.fromPrefix || pathValue.startsWith(`${input.fromPrefix}/`)) {
      if (input.toPrefix === null) {
        continue;
      }
      const suffix = pathValue.slice(input.fromPrefix.length);
      nextPaths.add(`${input.toPrefix}${suffix}`);
      continue;
    }
    nextPaths.add(pathValue);
  }

  return nextPaths;
}
