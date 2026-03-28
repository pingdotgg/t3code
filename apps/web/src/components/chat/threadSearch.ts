import type { TimelineRow } from "./MessagesTimeline.logic";

export interface ThreadSearchResult {
  rowId: string;
  rowIndex: number;
  matchCount: number;
}

export interface ThreadSearchIndexEntry {
  rowId: string;
  rowIndex: number;
  normalizedTexts: readonly string[];
}

export interface ThreadSearchLookupState {
  normalizedQuery: string;
  sourceIndex: ReadonlyArray<ThreadSearchIndexEntry>;
  matchingEntries: ReadonlyArray<ThreadSearchIndexEntry>;
  results: ReadonlyArray<ThreadSearchResult>;
}

function normalizeThreadSearchText(value: string): string {
  return value.toLocaleLowerCase();
}

function countMatches(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }

  let count = 0;
  let searchStart = 0;
  while (searchStart <= haystack.length - needle.length) {
    const matchIndex = haystack.indexOf(needle, searchStart);
    if (matchIndex < 0) {
      break;
    }
    count += 1;
    searchStart = matchIndex + needle.length;
  }
  return count;
}

function collectRowSearchText(row: TimelineRow): string[] {
  switch (row.kind) {
    case "message":
      return [
        row.message.text,
        ...(row.message.attachments?.map((attachment) => attachment.name) ?? []),
      ];
    case "proposed-plan":
      return [row.proposedPlan.planMarkdown];
    case "work":
      return row.groupedEntries.flatMap((entry) => [
        entry.label,
        entry.detail ?? "",
        entry.command ?? "",
        ...(entry.changedFiles ?? []),
      ]);
    case "working":
      return [];
  }
}

export function buildThreadSearchIndex(
  rows: ReadonlyArray<TimelineRow>,
): ReadonlyArray<ThreadSearchIndexEntry> {
  return rows.map((row, rowIndex) => ({
    rowId: row.id,
    rowIndex,
    normalizedTexts: collectRowSearchText(row).flatMap((value) => {
      const nextValue = normalizeThreadSearchText(value.trim());
      return nextValue.length > 0 ? [nextValue] : [];
    }),
  }));
}

function searchCandidateEntries(
  candidateEntries: ReadonlyArray<ThreadSearchIndexEntry>,
  normalizedQuery: string,
): {
  matchingEntries: ReadonlyArray<ThreadSearchIndexEntry>;
  results: ReadonlyArray<ThreadSearchResult>;
} {
  const matchingEntries: ThreadSearchIndexEntry[] = [];
  const results = candidateEntries.flatMap((entry) => {
    const matchCount = entry.normalizedTexts.reduce((total, value) => {
      if (!value.includes(normalizedQuery)) {
        return total;
      }
      return total + countMatches(value, normalizedQuery);
    }, 0);
    if (matchCount <= 0) {
      return [];
    }
    matchingEntries.push(entry);
    return [
      {
        rowId: entry.rowId,
        rowIndex: entry.rowIndex,
        matchCount,
      } satisfies ThreadSearchResult,
    ];
  });

  return {
    matchingEntries,
    results,
  };
}

export function createEmptyThreadSearchLookupState(
  index: ReadonlyArray<ThreadSearchIndexEntry>,
): ThreadSearchLookupState {
  return {
    normalizedQuery: "",
    sourceIndex: index,
    matchingEntries: [],
    results: [],
  };
}

export function findThreadSearchLookupState(
  index: ReadonlyArray<ThreadSearchIndexEntry>,
  query: string,
  previousState?: ThreadSearchLookupState | null,
): ThreadSearchLookupState {
  const normalizedQuery = normalizeThreadSearchText(query.trim());
  if (normalizedQuery.length === 0) {
    return createEmptyThreadSearchLookupState(index);
  }

  const canNarrowFromPrevious =
    previousState !== undefined &&
    previousState !== null &&
    previousState.sourceIndex === index &&
    previousState.normalizedQuery.length > 0 &&
    normalizedQuery.startsWith(previousState.normalizedQuery);

  const candidateEntries = canNarrowFromPrevious ? previousState.matchingEntries : index;
  const { matchingEntries, results } = searchCandidateEntries(candidateEntries, normalizedQuery);
  return {
    normalizedQuery,
    sourceIndex: index,
    matchingEntries,
    results,
  };
}

export function findThreadSearchResultsFromIndex(
  index: ReadonlyArray<ThreadSearchIndexEntry>,
  query: string,
  previousState?: ThreadSearchLookupState | null,
): ReadonlyArray<ThreadSearchResult> {
  return findThreadSearchLookupState(index, query, previousState).results;
}

export function findThreadSearchResults(
  rows: ReadonlyArray<TimelineRow>,
  query: string,
): ReadonlyArray<ThreadSearchResult> {
  return findThreadSearchResultsFromIndex(buildThreadSearchIndex(rows), query);
}
