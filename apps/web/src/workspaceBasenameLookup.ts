import { isWindowsAbsolutePath } from "@t3tools/shared/path";

// Enough hits to look past same-named neighbours (`ChatView.test.tsx`) without
// asking for a full listing on a single click.
export const WORKSPACE_BASENAME_LOOKUP_LIMIT = 25;

// One counter for every caller: they all open the same panel, so the newest
// click wins regardless of which one started the lookup.
let latestLookupSequence = 0;

/** Call the returned predicate when the search settles; false means a later click superseded it. */
export function claimWorkspaceBasenameLookup(): () => boolean {
  latestLookupSequence += 1;
  const claimed = latestLookupSequence;
  return () => claimed === latestLookupSequence;
}

export interface WorkspaceEntryCandidate {
  readonly path: string;
  readonly kind: "file" | "directory";
}

function basenameOfPath(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
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

export function pickWorkspaceBasenameMatch(
  basename: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null {
  const target = basename.trim();
  if (!target) return null;
  const files = entries.filter((entry) => entry.kind === "file");
  const exact = files.find((entry) => basenameOfPath(entry.path) === target);
  if (exact) return exact.path;
  // Folded matching covers casing that drifted from disk, but `FOO.ts` against
  // both `Foo.ts` and `foo.ts` has no right answer, so it resolves to nothing
  // rather than opening whichever the index ranked first.
  const folded = target.toLowerCase();
  const foldedMatches = files.filter(
    (entry) => basenameOfPath(entry.path).toLowerCase() === folded,
  );
  return foldedMatches.length === 1 ? (foldedMatches[0]?.path ?? null) : null;
}

/**
 * Agents echo git paths relative to the repository root, so in a project that
 * is a subfolder of its repository `physics/notes/a.md` repeats the project's
 * own folder. Returns the path with that repeated prefix removed, if any.
 */
export function stripRepeatedWorkspacePrefix(relativePath: string, cwd: string): string | null {
  const pathSegments = relativePath.split(/[\\/]+/);
  const cwdSegments = cwd.split(/[\\/]+/).filter(Boolean);
  const fold = isWindowsAbsolutePath(cwd)
    ? (segment: string | undefined) => segment?.toLowerCase()
    : (segment: string | undefined) => segment;
  for (let count = Math.min(cwdSegments.length, pathSegments.length - 1); count > 0; count--) {
    const prefix = cwdSegments.slice(-count);
    if (prefix.every((segment, index) => fold(segment) === fold(pathSegments[index]))) {
      return pathSegments.slice(count).join("/");
    }
  }
  return null;
}

/**
 * Resolves a stripped path against index entries. A real child folder named
 * like the project keeps the literal path, so this returns null when the
 * literal path is indexed too.
 */
export function pickStrippedWorkspaceMatch(
  literalPath: string,
  strippedPath: string,
  cwd: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
): string | null {
  const caseInsensitive = isWindowsAbsolutePath(cwd);
  const key = (path: string) => {
    const normalized = path.replaceAll("\\", "/");
    return caseInsensitive ? normalized.toLowerCase() : normalized;
  };
  const pathsByKey = new Map(
    entries.filter((entry) => entry.kind === "file").map((entry) => [key(entry.path), entry.path]),
  );
  if (pathsByKey.has(key(literalPath))) return null;
  return pathsByKey.get(key(strippedPath)) ?? null;
}
