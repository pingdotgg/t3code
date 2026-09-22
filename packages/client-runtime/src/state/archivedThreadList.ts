import { normalizeSearchQuery, scoreQueryMatch } from "@t3tools/shared/searchRanking";

const ARCHIVED_THREAD_ALL_TOKENS_SCORE_OFFSET = 1_000;
const ARCHIVED_THREAD_PARTIAL_TOKENS_SCORE_OFFSET = 5_000;
const ARCHIVED_THREAD_MISSING_TOKEN_SCORE_OFFSET = 1_000;
const ARCHIVED_THREAD_PHRASE_SCORE_MAX = ARCHIVED_THREAD_ALL_TOKENS_SCORE_OFFSET - 1;
const ARCHIVED_THREAD_ALL_TOKENS_SCORE_MAX =
  ARCHIVED_THREAD_PARTIAL_TOKENS_SCORE_OFFSET - ARCHIVED_THREAD_ALL_TOKENS_SCORE_OFFSET - 1;

export type ArchivedThreadSortField = "archivedAt" | "createdAt";
export type ArchivedThreadSortDirection = "asc" | "desc";

export interface ArchivedThreadSortState {
  readonly field: ArchivedThreadSortField;
  readonly direction: ArchivedThreadSortDirection;
}

export interface ArchivedThreadSearchInput {
  readonly normalizedQuery: string;
  readonly tokens: ReadonlyArray<string>;
  readonly isSearching: boolean;
}

export interface ArchivedThreadActionLock {
  readonly keys: ReadonlyArray<string>;
}

export function archivedThreadActionKey(threadRef: {
  readonly environmentId: string;
  readonly threadId: string;
}): string {
  return JSON.stringify([threadRef.environmentId, threadRef.threadId]);
}

export function tryAcquireArchivedThreadActionLock(
  inFlightThreadKeys: Set<string>,
  threadRefs: ReadonlyArray<{ readonly environmentId: string; readonly threadId: string }>,
): ArchivedThreadActionLock | null {
  const keys = [...new Set(threadRefs.map(archivedThreadActionKey))];
  if (keys.some((key) => inFlightThreadKeys.has(key))) {
    return null;
  }
  for (const key of keys) {
    inFlightThreadKeys.add(key);
  }
  return { keys };
}

export function releaseArchivedThreadActionLock(
  inFlightThreadKeys: Set<string>,
  lock: ArchivedThreadActionLock,
): void {
  for (const key of lock.keys) {
    inFlightThreadKeys.delete(key);
  }
}

export function parseArchivedThreadSearchInput(query: string): ArchivedThreadSearchInput {
  const normalizedQuery = normalizeSearchQuery(query);
  return {
    normalizedQuery,
    tokens: normalizedQuery.split(/\s+/u).filter((token) => token.length > 0),
    isSearching: normalizedQuery.length > 0,
  };
}

// Lower search scores are more relevant, matching the shared search-ranking helpers.
export function archivedThreadSearchScore(input: {
  readonly normalizedTitle: string;
  readonly normalizedQuery: string;
  readonly tokens: ReadonlyArray<string>;
}): number | null {
  if (input.normalizedQuery.length === 0) {
    return 0;
  }

  if (!input.normalizedTitle) {
    return null;
  }

  const phraseScore = scoreQueryMatch({
    value: input.normalizedTitle,
    query: input.normalizedQuery,
    exactBase: 0,
    prefixBase: 1,
    boundaryBase: 2,
    includesBase: 3,
  });
  if (phraseScore !== null) {
    return Math.min(phraseScore, ARCHIVED_THREAD_PHRASE_SCORE_MAX);
  }

  const distinctTokens = [...new Set(input.tokens)];
  let matchedTokenCount = 0;
  let tokenScore = 0;
  for (const token of distinctTokens) {
    const score = scoreQueryMatch({
      value: input.normalizedTitle,
      query: token,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      ...(token.length >= 3 ? { fuzzyBase: 100 } : {}),
    });
    if (score === null) {
      continue;
    }

    matchedTokenCount += 1;
    tokenScore += score;
  }

  if (matchedTokenCount === 0) {
    return null;
  }

  if (matchedTokenCount === distinctTokens.length) {
    return (
      ARCHIVED_THREAD_ALL_TOKENS_SCORE_OFFSET +
      Math.min(tokenScore, ARCHIVED_THREAD_ALL_TOKENS_SCORE_MAX)
    );
  }

  return (
    ARCHIVED_THREAD_PARTIAL_TOKENS_SCORE_OFFSET +
    (distinctTokens.length - matchedTokenCount) * ARCHIVED_THREAD_MISSING_TOKEN_SCORE_OFFSET +
    Math.min(tokenScore, ARCHIVED_THREAD_MISSING_TOKEN_SCORE_OFFSET - 1)
  );
}

export function archivedThreadTimestampValue(
  thread: { readonly archivedAt: string | null; readonly createdAt: string },
  field: ArchivedThreadSortField,
): string {
  if (field === "createdAt" || thread.archivedAt === null) return thread.createdAt;
  return Number.isNaN(Date.parse(thread.archivedAt)) ? thread.createdAt : thread.archivedAt;
}

export function archivedThreadSortTimestamp(
  thread: { readonly archivedAt: string | null; readonly createdAt: string },
  field: ArchivedThreadSortField,
): number {
  const timestamp = Date.parse(archivedThreadTimestampValue(thread, field));
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function compareArchivedThreads<
  T extends { readonly id: string; readonly archivedAt: string | null; readonly createdAt: string },
>(left: T, right: T, sort: ArchivedThreadSortState): number {
  const leftTimestamp = archivedThreadSortTimestamp(left, sort.field);
  const rightTimestamp = archivedThreadSortTimestamp(right, sort.field);
  const timestampComparison =
    sort.direction === "asc" ? leftTimestamp - rightTimestamp : rightTimestamp - leftTimestamp;
  return timestampComparison || left.id.localeCompare(right.id);
}

export function nextArchivedThreadSortState(
  current: ArchivedThreadSortState,
  field: ArchivedThreadSortField,
): ArchivedThreadSortState {
  if (current.field !== field) {
    return { field, direction: "desc" };
  }
  return { field, direction: current.direction === "desc" ? "asc" : "desc" };
}
