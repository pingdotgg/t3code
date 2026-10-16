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

function slashPath(path: string): string {
  return path.trim().replaceAll("\\", "/");
}

/**
 * The one indexed file whose path ends with every segment of `relativePath`,
 * e.g. `docs/plan.md` in `BudgetLens/docs/plan.md`. Two candidates have no
 * right answer, so they resolve to nothing. The index ranks whole-suffix
 * matches ahead of fuzzy ones, so a truncated page can hide another match
 * only when its last file is a match too.
 */
export function pickWorkspaceSuffixMatch(
  relativePath: string,
  entries: ReadonlyArray<WorkspaceEntryCandidate>,
  truncated = false,
): string | null {
  const target = slashPath(relativePath);
  if (!target) return null;
  const files = entries.filter((entry) => entry.kind === "file");
  const matching = (fold: (path: string) => string) => {
    const suffix = fold(target);
    return files.filter((entry) => {
      const path = fold(slashPath(entry.path));
      return path === suffix || path.endsWith(`/${suffix}`);
    });
  };
  const exact = matching((path) => path);
  const matches = exact.length > 0 ? exact : matching((path) => path.toLowerCase());
  const match = matches.length === 1 ? matches[0] : undefined;
  if (!match || (truncated && files.at(-1) === match)) return null;
  return match.path;
}

/**
 * Which workspace file a chip's workspace-relative path opens, or null to keep
 * the literal path. Agents name files relative to the folder they work in, so
 * a bare name asks the index, and a path with directories asks it only when
 * the literal file is missing: the index skips ignored files, so its silence
 * proves nothing about the literal path.
 */
export async function findWorkspaceFileMatch(
  relativePath: string,
  lookup: {
    /** False only when the literal file is known to be missing. */
    readonly literalExists: () => Promise<boolean>;
    /** Indexed candidates for the query, or null when the search failed. */
    readonly searchFiles: (query: string) => Promise<{
      readonly entries: ReadonlyArray<WorkspaceEntryCandidate>;
      readonly truncated: boolean;
    } | null>;
  },
): Promise<string | null> {
  if (needsWorkspaceBasenameLookup(relativePath)) {
    const result = await lookup.searchFiles(relativePath);
    return result ? pickWorkspaceBasenameMatch(relativePath, result.entries) : null;
  }
  if (!/[\\/]/.test(relativePath) || (await lookup.literalExists())) return null;
  const result = await lookup.searchFiles(relativePath);
  return result ? pickWorkspaceSuffixMatch(relativePath, result.entries, result.truncated) : null;
}
