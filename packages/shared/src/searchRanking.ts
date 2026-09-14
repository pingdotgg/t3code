import { expandQueryAcrossKeyboardLayouts } from "./keyboardLayouts.ts";

export type RankedSearchResult<T> = {
  item: T;
  score: number;
  tieBreaker: string;
};

export function normalizeSearchQuery(
  input: string,
  options?: {
    trimLeadingPattern?: RegExp;
  },
): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return "";
  }
  return options?.trimLeadingPattern
    ? trimmed.replace(options.trimLeadingPattern, "").toLowerCase()
    : trimmed.toLowerCase();
}

export function scoreSubsequenceMatch(value: string, query: string): number | null {
  if (!query) return 0;

  let queryIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;

  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) {
      continue;
    }

    if (firstMatchIndex === -1) {
      firstMatchIndex = valueIndex;
    }
    if (previousMatchIndex !== -1) {
      gapPenalty += valueIndex - previousMatchIndex - 1;
    }

    previousMatchIndex = valueIndex;
    queryIndex += 1;
    if (queryIndex === query.length) {
      const spanPenalty = valueIndex - firstMatchIndex + 1 - query.length;
      const lengthPenalty = Math.min(64, value.length - query.length);
      return firstMatchIndex * 2 + gapPenalty * 3 + spanPenalty + lengthPenalty;
    }
  }

  return null;
}

function lengthPenalty(value: string, query: string): number {
  return Math.min(64, Math.max(0, value.length - query.length));
}

function findBoundaryMatchIndex(
  value: string,
  query: string,
  boundaryMarkers: readonly string[],
): number | null {
  let bestIndex: number | null = null;

  for (const marker of boundaryMarkers) {
    const index = value.indexOf(`${marker}${query}`);
    if (index === -1) {
      continue;
    }

    const matchIndex = index + marker.length;
    if (bestIndex === null || matchIndex < bestIndex) {
      bestIndex = matchIndex;
    }
  }

  return bestIndex;
}

interface ScoreQueryMatchInput {
  value: string;
  query: string;
  exactBase: number;
  prefixBase?: number;
  boundaryBase?: number;
  includesBase?: number;
  fuzzyBase?: number;
  boundaryMarkers?: readonly string[];
}

/**
 * Added to a score only reachable after mapping the query off another keyboard
 * layout, so a direct match outranks every layout-mapped one. The tiers that
 * scale with the match index grow with the value rather than with the query, so
 * a direct score first reaches this penalty at a value of roughly 5,000
 * characters, and the fuzzy tier, which grows about four times as fast, at
 * roughly 2,500. Names, labels and descriptions all stay far below the tighter
 * of the two; a caller scoring a file's contents or a very long path would have
 * to raise this.
 */
const LAYOUT_MATCH_PENALTY = 10_000;

function scoreTieredMatch(input: ScoreQueryMatchInput, query: string): number | null {
  const { value } = input;

  if (!value || !query) {
    return null;
  }

  if (value === query) {
    return input.exactBase;
  }

  if (input.prefixBase !== undefined && value.startsWith(query)) {
    return input.prefixBase + lengthPenalty(value, query);
  }

  if (input.boundaryBase !== undefined) {
    const boundaryIndex = findBoundaryMatchIndex(
      value,
      query,
      input.boundaryMarkers ?? [" ", "-", "_", "/"],
    );
    if (boundaryIndex !== null) {
      return input.boundaryBase + boundaryIndex * 2 + lengthPenalty(value, query);
    }
  }

  if (input.includesBase !== undefined) {
    const includesIndex = value.indexOf(query);
    if (includesIndex !== -1) {
      return input.includesBase + includesIndex * 2 + lengthPenalty(value, query);
    }
  }

  if (input.fuzzyBase !== undefined) {
    const fuzzyScore = scoreSubsequenceMatch(value, query);
    if (fuzzyScore !== null) {
      return input.fuzzyBase + fuzzyScore;
    }
  }

  return null;
}

/**
 * Scores how well `value` matches `query` using tiered match strategies.
 *
 * A query typed while a non-Latin keyboard layout was active is also scored as
 * the US QWERTY characters its keys would have produced, behind
 * {@link LAYOUT_MATCH_PENALTY}. Those variants run through the whole tier chain,
 * fuzzy included, so a mapped query behaves like the same query typed on a US
 * layout.
 *
 * **Expects pre-normalized inputs**: both `value` and `query` must already be
 * trimmed and lowercased (e.g. via {@link normalizeSearchQuery}).
 */
export function scoreQueryMatch(input: ScoreQueryMatchInput): number | null {
  // Callers score several fields per item and pass "" for the absent ones, and
  // scoring every layout variant is the expensive half of this function. Both
  // of these leave before that: a value nothing can match, then a direct match,
  // which the layout penalty already keeps ahead of every variant.
  if (!input.value) {
    return null;
  }

  const directScore = scoreTieredMatch(input, input.query);
  if (directScore !== null) {
    return directScore;
  }

  let bestScore: number | null = null;
  for (const variant of expandQueryAcrossKeyboardLayouts(input.query)) {
    const variantScore = scoreTieredMatch(input, variant);
    if (variantScore === null) {
      continue;
    }
    const penalizedScore = variantScore + LAYOUT_MATCH_PENALTY;
    if (bestScore === null || penalizedScore < bestScore) {
      bestScore = penalizedScore;
    }
  }

  return bestScore;
}

function compareRankedSearchResults<T>(
  left: RankedSearchResult<T>,
  right: RankedSearchResult<T>,
): number {
  const scoreDelta = left.score - right.score;
  if (scoreDelta !== 0) return scoreDelta;
  return left.tieBreaker.localeCompare(right.tieBreaker);
}

function findInsertionIndex<T>(
  rankedEntries: RankedSearchResult<T>[],
  candidate: RankedSearchResult<T>,
): number {
  let low = 0;
  let high = rankedEntries.length;

  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const current = rankedEntries[middle];
    if (!current) {
      break;
    }

    if (compareRankedSearchResults(candidate, current) < 0) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }

  return low;
}

export function insertRankedSearchResult<T>(
  rankedEntries: RankedSearchResult<T>[],
  candidate: RankedSearchResult<T>,
  limit: number,
): void {
  if (limit <= 0) {
    return;
  }

  const insertionIndex = findInsertionIndex(rankedEntries, candidate);
  if (rankedEntries.length < limit) {
    rankedEntries.splice(insertionIndex, 0, candidate);
    return;
  }

  if (insertionIndex >= limit) {
    return;
  }

  rankedEntries.splice(insertionIndex, 0, candidate);
  rankedEntries.pop();
}
