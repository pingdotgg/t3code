import { isAbsolutePath, isHostPath, isWindowsAbsolutePath } from "@t3tools/shared/path";

export const WORKSPACE_BASENAME_LOOKUP_LIMIT = 25;

// All callers open one panel; the newest click must win across callers.
let latestLookupSequence = 0;

export function claimWorkspaceBasenameLookup(): () => boolean {
  latestLookupSequence += 1;
  const claimed = latestLookupSequence;
  return () => claimed === latestLookupSequence;
}

export interface WorkspaceEntryCandidate {
  readonly path: string;
  readonly kind: "file" | "directory";
}

export function needsWorkspaceBasenameLookup(relativePath: string): boolean {
  const trimmed = relativePath.trim();
  return (
    trimmed !== "." &&
    trimmed !== ".." &&
    trimmed.length > 0 &&
    !trimmed.includes("/") &&
    !trimmed.includes("\\")
  );
}

// A slashed path names a suffix of the file's workspace path, so it only
// resolves when exactly one indexed file ends with it.
export function pickWorkspaceBasenameMatch(
  relativePath: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null {
  const target = relativePath
    .trim()
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "");
  if (
    isHostPath(target) ||
    target.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  const files = entries.filter((entry) => entry.kind === "file");
  const matchesOf = (key: (path: string) => string) =>
    files.filter((entry) => {
      const path = key(entry.path.replaceAll("\\", "/"));
      const suffix = key(target);
      return path === suffix || path.endsWith(`/${suffix}`);
    });
  const exact = matchesOf((path) => path);
  if (exact.length > 0) {
    return !target.includes("/") || exact.length === 1 ? (exact[0]?.path ?? null) : null;
  }
  const folded = matchesOf((path) => path.toLowerCase());
  return folded.length === 1 ? (folded[0]?.path ?? null) : null;
}

// Repository-relative paths can repeat the project's suffix in subfolder projects.
export function stripRepeatedWorkspacePrefix(relativePath: string, cwd: string): string | null {
  if (isAbsolutePath(relativePath)) return null;
  const pathSegments = relativePath.split(/[\\/]+/);
  const cwdSegments = cwd.split(/[\\/]+/).filter(Boolean);
  const fold = isWindowsAbsolutePath(cwd)
    ? (segment: string | undefined) => segment?.toLowerCase()
    : (segment: string | undefined) => segment;
  for (let count = Math.min(cwdSegments.length, pathSegments.length - 1); count > 0; count--) {
    const prefix = cwdSegments.slice(-count);
    if (prefix.every((segment, index) => fold(segment) === fold(pathSegments[index]))) {
      return pathSegments.slice(count).join("/") || null;
    }
  }
  return null;
}

export function pickStrippedWorkspaceMatch(
  strippedPath: string,
  cwd: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null {
  const caseInsensitive = isWindowsAbsolutePath(cwd);
  const key = (path: string) => {
    const normalized = path.replaceAll("\\", "/");
    return caseInsensitive ? normalized.toLowerCase() : normalized;
  };
  const files = entries.filter((entry) => entry.kind === "file");
  return files.find((entry) => key(entry.path) === key(strippedPath))?.path ?? null;
}
