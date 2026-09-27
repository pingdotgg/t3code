export type RankedSearchResult<T> = {
  item: T;
  score: number;
  tieBreaker: string;
};

/**
 * Folds text to a form where matching ignores the differences a reader should
 * not have to care about: case, accents, and Turkish dotted/dotless I.
 *
 * The Turkish fold is the reason this is not `toLowerCase`. Turkish and
 * Azerbaijani added a dotless `ı`, and no normalization maps it to `i`, so a
 * developer who types "yapilandirma" never finds "Yapılandırma" and a label
 * reading "İptal" is unreachable by typing "iptal". Turkish developers type
 * ASCII by reflex even when the UI is Turkish, and the command palette indexes
 * English keywords, so the search box has to meet them in the middle.
 *
 * The fold is deliberately locale-independent. Callers include the server, which
 * has no locale of its own, and it must reach the same answer for the same
 * input. Collapsing `i` and `ı` into one form costs exactly one extra match —
 * typing `i` also finds `ı` — and removes a whole class of dead searches.
 *
 * Combining marks are dropped only when they sit on a Latin letter. Stripping
 * every `\p{M}` would also erase the marks that *carry* meaning in other
 * scripts, collapsing Arabic "بَ" onto "ب" and Hebrew "שָׁלוֹם" onto "שלום".
 * Those scripts are written without case, so the fold has no business touching
 * them; leaving their marks intact keeps distinct spellings distinct.
 */
export function foldForSearch(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/\s+/g, " ")
    .trim();
}

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
  // Deliberately not folded. Callers hand the result of this function to
  // `scoreQueryMatch` alongside candidate terms that were only lowercased, so
  // folding here would compare a folded query against an unfolded candidate and
  // lose matches that used to work: searching "café" would stop finding "Café".
  // The fold belongs on both sides at once, so `scoreQueryMatch` applies it as a
  // fallback after the plain comparison has already failed.
  return options?.trimLeadingPattern
    ? trimmed.replace(options.trimLeadingPattern, "").toLowerCase()
    : trimmed.toLowerCase();
}

type ScoreQueryMatchInput = {
  value: string;
  query: string;
  exactBase: number;
  prefixBase?: number;
  boundaryBase?: number;
  includesBase?: number;
  fuzzyBase?: number;
  boundaryMarkers?: readonly string[];
};

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

/**
 * Scores how well `value` matches `query` using tiered match strategies.
 *
 * **Expects pre-normalized inputs**: both `value` and `query` must already be
 * trimmed and lowercased (e.g. via {@link normalizeSearchQuery}).
 *
 * When the plain comparison finds nothing, the same comparison is retried with
 * both sides run through {@link foldForSearch}, which is what lets "iptal" find
 * "İptal" and "cafe" find "Café". The fold has to be applied to the candidate as
 * well as the query: folding only the query would compare `cafe` against `café`
 * and lose the match. Retrying rather than pre-folding is deliberate — callers
 * index thousands of candidates per keystroke, and a fallback that only runs
 * after a miss leaves the hot path byte-for-byte what it was, so no query that
 * matched before can stop matching.
 */
export function scoreQueryMatch(input: ScoreQueryMatchInput): number | null {
  const direct = scoreNormalizedMatch(input);
  if (direct !== null) {
    return direct;
  }

  const value = foldForSearch(input.value);
  const query = foldForSearch(input.query);
  if (value === input.value && query === input.query) {
    return null;
  }

  return scoreNormalizedMatch({ ...input, value, query });
}

function scoreNormalizedMatch(input: ScoreQueryMatchInput): number | null {
  const { value, query } = input;

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
