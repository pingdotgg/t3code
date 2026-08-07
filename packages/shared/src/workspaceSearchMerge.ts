/**
 * Merge per-folder workspace search results into one ranked list.
 *
 * Each source folder is queried independently (one search index per root on the
 * server), so the client receives N separately-ordered result sets. The server
 * exposes no scores — only its own ordering — so the merge re-ranks from
 * scratch using the shared ranking primitives, falling back to each folder's
 * own position when the query matched in a way we cannot reproduce.
 *
 * @module workspaceSearchMerge
 */
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
  type RankedSearchResult,
} from "./searchRanking.ts";
import type { WorkspaceFolder } from "./workspaceFolders.ts";

/**
 * Score floor for entries the upstream index matched via a signal we cannot
 * reproduce locally. Ranked strictly below every locally-scored match, ordered
 * among themselves by the folder's own ranking.
 */
const UNSCORED_BASE = 1_000;

/** Nudge that lets the primary folder win an otherwise exact tie. */
const NON_PRIMARY_TIE_BREAK = 0.5;

export interface WorkspaceFolderEntry {
  /** Path relative to the folder's cwd. */
  readonly path: string;
  readonly kind?: string;
}

export interface FolderQualifiedEntry<TEntry extends WorkspaceFolderEntry> {
  readonly folder: WorkspaceFolder;
  readonly entry: TEntry;
}

export interface FolderSearchInput<TEntry extends WorkspaceFolderEntry> {
  readonly folder: WorkspaceFolder;
  readonly entries: ReadonlyArray<TEntry>;
  readonly truncated?: boolean;
}

export interface MergedFolderSearchResult<TEntry extends WorkspaceFolderEntry> {
  readonly entries: ReadonlyArray<FolderQualifiedEntry<TEntry>>;
  readonly truncated: boolean;
}

function basename(path: string): string {
  const segments = path.split("/");
  return segments.at(-1) ?? path;
}

/**
 * Rank entries from every folder into one list.
 *
 * `limit` caps the merged list, not each folder — otherwise a project with four
 * folders would return four times as many rows as a single-folder one.
 */
export function mergeFolderEntryResults<TEntry extends WorkspaceFolderEntry>(input: {
  readonly perFolder: ReadonlyArray<FolderSearchInput<TEntry>>;
  readonly query: string;
  readonly limit: number;
}): MergedFolderSearchResult<TEntry> {
  const query = normalizeSearchQuery(input.query);
  const ranked: Array<RankedSearchResult<FolderQualifiedEntry<TEntry>>> = [];
  let truncated = false;

  for (const source of input.perFolder) {
    if (source.truncated === true) truncated = true;

    source.entries.forEach((entry, folderRank) => {
      const score =
        query.length === 0
          ? // No query: preserve each folder's own ordering.
            folderRank
          : (scoreQueryMatch({
              value: basename(entry.path).toLowerCase(),
              query,
              exactBase: 0,
              prefixBase: 2,
              boundaryBase: 6,
              includesBase: 10,
              fuzzyBase: 20,
            }) ??
            scoreQueryMatch({
              value: entry.path.toLowerCase(),
              query,
              exactBase: 30,
              includesBase: 34,
              fuzzyBase: 40,
            }) ??
            UNSCORED_BASE + folderRank);

      insertRankedSearchResult(
        ranked,
        {
          item: { folder: source.folder, entry },
          score: score + (source.folder.isPrimary ? 0 : NON_PRIMARY_TIE_BREAK),
          tieBreaker: `${source.folder.label}/${entry.path}`,
        },
        input.limit,
      );
    });
  }

  const totalEntries = input.perFolder.reduce((sum, source) => sum + source.entries.length, 0);
  return {
    entries: ranked.map((result) => result.item),
    truncated: truncated || totalEntries > input.limit,
  };
}

/**
 * Group content-search matches by folder, preserving each folder's own ordering.
 *
 * Content relevance is not comparable across folders (each index scores against
 * its own corpus) and the UI already groups by file, so these are concatenated
 * in folder order rather than re-ranked.
 */
export function mergeFolderContentMatches<TMatch>(input: {
  readonly perFolder: ReadonlyArray<{
    readonly folder: WorkspaceFolder;
    readonly matches: ReadonlyArray<TMatch>;
    readonly truncated?: boolean;
  }>;
  readonly limit: number;
}): {
  readonly matches: ReadonlyArray<{ readonly folder: WorkspaceFolder; readonly match: TMatch }>;
  readonly truncated: boolean;
} {
  const matches: Array<{ folder: WorkspaceFolder; match: TMatch }> = [];
  let truncated = false;

  for (const source of input.perFolder) {
    if (source.truncated === true) truncated = true;
    for (const match of source.matches) {
      if (matches.length >= input.limit) {
        return { matches, truncated: true };
      }
      matches.push({ folder: source.folder, match });
    }
  }

  return { matches, truncated };
}
