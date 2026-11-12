import { ALPHANUMERIC, COMBINING_MARKS, CURLY_APOSTROPHES, DIGIT, FILLER_WORDS, MESSAGE_NEAR_BONUS, MESSAGE_NEAR_SPAN, MESSAGE_PHRASE_BONUS, MESSAGE_WORD_START_LENGTH, MID_WORD, NON_ASCII, SYMBOL, WHOLE_NAME, foldInPlace, foldSearchField, foldSearchQuery, isWordStart, matchSearchFields, mergeRanges, messagePhrase, messageSearchTokens } from "./paletteSearch-02-alphan.ts";
import type { MessageMatch, RankedSearchItem, SearchFieldsMatch, SearchMatchHint, SearchRange, SearchTermsMatch, SearchTextPart, ThreadOpenStats, ThreadSearchMatch, ThreadSearchSubject, WeightedSearchField } from "./paletteSearch-02-alphan.ts";
import type { OrchestrationV2ThreadOpens } from "@t3tools/contracts";
import { WORKTREE_BRANCH_PREFIX } from "./git.ts";
/** Shared ranking keeps command palettes and MCP thread search consistent across surfaces. */

export const MESSAGE_PREFIX = 0.8;

export function startsWordAt(text: string, index: number): boolean {
  const character = text[index]!;
  // A token that opens with punctuation (such as ".ts") brings its own boundary.
  if (!ALPHANUMERIC.test(character) && !SYMBOL.test(character)) return true;
  return isWordStart(
    text[index - 2] ?? "",
    text[index - 1] ?? "",
    character,
    text[index + 1] ?? "",
  );
}

// Whether a word ends right before `end` in `text`.
export function endsWordAt(text: string, end: number): boolean {
  return end >= text.length || !ALPHANUMERIC.test(text[end]!) || startsWordAt(text, end);
}

// A commit SHA or UUID part: seven or more hex characters with a digit.
export const HEX_ID = /^(?=[a-f]*\d)[0-9a-f]{7,}$/i;

// Where `token` best sits in `folded`, a fold of `text`: every place it is a
// whole word, else a word start, else inside a word. Hits past the start of a
// hex ID do not count ("cafe" in "7cafe52bb8"), though a pasted SHA prefix
// does.
export function findMessageToken(
  text: string,
  folded: string,
  token: string,
  firstOnly: boolean,
): { readonly at: ReadonlyArray<number>; readonly quality: number } | null {
  let quality = 0;
  let at: number[] = [];
  // The letters-and-digits run around the hit, kept for later hits in the
  // same run: rescanning it per hit is quadratic in a long run ("0000" in a
  // hex dump).
  let run = { start: 0, end: -1, hex: false };
  for (let index = folded.indexOf(token); index !== -1; index = folded.indexOf(token, index + 1)) {
    if (index + token.length > run.end) {
      let start = index;
      while (start > 0 && ALPHANUMERIC.test(text[start - 1]!)) start--;
      let end = index + token.length;
      while (end < text.length && ALPHANUMERIC.test(text[end]!)) end++;
      run = { start, end, hex: HEX_ID.test(text.slice(start, end)) };
    }
    if (run.hex && run.start < index) continue;
    const found = !startsWordAt(text, index)
      ? MID_WORD
      : endsWordAt(text, index + token.length)
        ? 1
        : MESSAGE_PREFIX;
    if (found > quality) {
      quality = found;
      at = [index];
      if (firstOnly && quality === 1) return { at, quality };
    } else if (!firstOnly && found === quality) {
      at.push(index);
    }
  }
  return at.length === 0 ? null : { at, quality };
}

export function messageMatcher(query: string): (text: string) => MessageMatch | null {
  const { long, short, words } = messageSearchTokens(query);
  const tokens = [...long, ...short].map((token) => ({
    token,
    // Marks go from the folded token: lowercasing "İ" adds one.
    folded: foldInPlace(token).replace(COMBINING_MARKS, ""),
    nonAscii: NON_ASCII.test(token),
    mustStartWord: Array.from(token).length < MESSAGE_WORD_START_LENGTH,
    // Too short to search, so it only narrows: grading by it would reorder
    // results on each keystroke while the next word is typed ("nvme s").
    grades: long.includes(token),
  }));
  const phrase = messagePhrase(query);
  // Accents typed or left out still read as written together: "cafe open"
  // in "Café open".
  const foldedPhrase = messagePhrase(
    words.map((word) => foldInPlace(word).replace(COMBINING_MARKS, "")).join(" "),
  );
  const queryNonAscii = NON_ASCII.test(query);
  return (text) => {
    const lower = text.toLowerCase();
    // "İ" lowercases to two units, which would shift every offset after it.
    const plain = lower.length === text.length ? lower : foldInPlace(text);
    let folded: string | null = null;
    let quality = 1;
    const positions: Array<ReadonlyArray<number>> = [];
    for (const { token, folded: foldedToken, nonAscii, mustStartWord, grades } of tokens) {
      let found = findMessageToken(text, plain, token, tokens.length === 1);
      // Accents typed or left out: "cafe" finds "Café", also after "cafeteria".
      if (found?.quality !== 1 && foldedToken.length > 0 && (nonAscii || NON_ASCII.test(text))) {
        found = findMessageToken(
          text,
          (folded ??= foldInPlace(text)),
          foldedToken,
          tokens.length === 1,
        );
      }
      if (found === null) return null;
      if (found.quality === MID_WORD && mustStartWord) return null;
      if (grades) quality = Math.min(quality, found.quality);
      positions.push(found.at);
    }
    // Written together as typed: the snippet starts there. Apostrophes are
    // straight in the query, and straightening keeps offsets.
    const straight = (value: string) => value.replace(CURLY_APOSTROPHES, "'");
    const together =
      phrase?.exec(straight(plain)) ??
      (queryNonAscii || NON_ASCII.test(text)
        ? foldedPhrase?.exec(straight((folded ??= foldInPlace(text))))
        : null);
    if (together) return { quality: quality + MESSAGE_PHRASE_BONUS, offset: together.index };
    // Else the shortest stretch that holds every word: the snippet starts
    // there, so it shows them all, and words close together rank above words
    // far apart ("lakebed perf").
    const near = shortestSpan(positions);
    return {
      quality:
        long.length > 1 && near.length <= MESSAGE_NEAR_SPAN
          ? quality + MESSAGE_NEAR_BONUS
          : quality,
      offset: near.start,
    };
  };
}

// The shortest stretch of text holding one place of each word, from each
// word's places in order.
export function shortestSpan(places: ReadonlyArray<ReadonlyArray<number>>): {
  readonly start: number;
  readonly length: number;
} {
  const hits = places
    .flatMap((at, word) => at.map((index) => ({ index, word })))
    .sort((left, right) => left.index - right.index);
  const counts = places.map(() => 0);
  let covered = 0;
  let best = { start: hits[0]?.index ?? 0, length: Number.POSITIVE_INFINITY };
  let left = 0;
  for (const hit of hits) {
    counts[hit.word] = (counts[hit.word] ?? 0) + 1;
    if (counts[hit.word] === 1) covered++;
    while (covered === places.length) {
      const first = hits[left]!;
      if (hit.index - first.index < best.length) {
        best = { start: first.index, length: hit.index - first.index };
      }
      counts[first.word] = (counts[first.word] ?? 1) - 1;
      if (counts[first.word] === 0) covered--;
      left++;
    }
  }
  return best;
}

/**
 * Ranges of `text` that contain a long message search token, for message
 * snippets, ignoring case and accents. Shorter tokens would light up half the
 * snippet, and a short long token only counts where it starts a word.
 * Snippets vary per query, so they skip the field cache.
 */
export function findSearchTokenRanges(text: string, query: string): SearchRange[] {
  const tokens = new Map(
    messageSearchTokens(query)
      .long.map(
        (token) =>
          [foldSearchQuery(token), Array.from(token).length < MESSAGE_WORD_START_LENGTH] as const,
      )
      // Some tokens fold to nothing ("´´´"), which would match everywhere.
      .filter(([token]) => token.length > 0),
  );
  if (tokens.size === 0) return [];
  const field = foldSearchField(text);
  const ranges: SearchRange[] = [];
  for (const [token, needsWordStart] of tokens) {
    // A token that opens with punctuation brings its own boundary, as in scoring.
    const ownBoundary = !ALPHANUMERIC.test(token[0]!) && !SYMBOL.test(token[0]!);
    for (let index = field.text.indexOf(token); index !== -1;) {
      if (needsWordStart && !ownBoundary && !field.wordStarts[index]) {
        index = field.text.indexOf(token, index + 1);
        continue;
      }
      ranges.push({ start: index, end: index + token.length });
      index = field.text.indexOf(token, index + token.length);
    }
  }
  return mergeRanges(ranges);
}

export function splitSearchText(
  text: string,
  ranges: ReadonlyArray<SearchRange>,
): SearchTextPart[] {
  const parts: SearchTextPart[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      parts.push({ text: text.slice(cursor, range.start), highlighted: false, start: cursor });
    }
    parts.push({ text: text.slice(range.start, range.end), highlighted: true, start: range.start });
    cursor = range.end;
  }
  if (cursor < text.length || parts.length === 0) {
    parts.push({ text: text.slice(cursor), highlighted: false, start: cursor });
  }
  return parts;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Both activity recency and open counts halve every two weeks. */
export const SEARCH_RECENCY_HALF_LIFE_MS = 14 * DAY_MS;
/**
 * Opens closer together than this count once, so flipping between threads is
 * not frequency. Clients skip sending them.
 */
export const THREAD_OPEN_DEDUPE_MS = 10 * 60 * 1000;
export const THREAD_SEARCH_PICK_LIMIT = 3;
/** Picked queries are stored this long; clients send no more. */
export const THREAD_SEARCH_PICK_MAX_LENGTH = 32;

/**
 * `query` as a pick is stored and compared: folded, then cut to the stored
 * length without splitting an emoji in two. Clients and the server both use
 * it, so a long pick matches its query again.
 */
export function pickedQuery(query: string): string {
  const cut = foldSearchQuery(query).slice(0, THREAD_SEARCH_PICK_MAX_LENGTH);
  return (/[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut).trim();
}

export function decay(ageMs: number): number {
  return 2 ** (-Math.max(0, ageMs) / SEARCH_RECENCY_HALF_LIFE_MS);
}

/** Server-stored open history; see `OrchestrationV2ThreadOpens`. */
export function recordThreadOpen(
  previous: ThreadOpenStats | null,
  at: number,
  query: string | undefined,
): ThreadOpenStats {
  const pick = pickedQuery(query ?? "");
  // Picks that no longer count are not kept or synced.
  const earlier = (previous?.picks ?? []).filter((entry) => at - entry.at <= PICK_WINDOW_MS);
  const picks = pick
    ? [{ query: pick, at }, ...earlier.filter((entry) => entry.query !== pick)].slice(
        0,
        THREAD_SEARCH_PICK_LIMIT,
      )
    : earlier;
  if (previous !== null && at - previous.openedAt < THREAD_OPEN_DEDUPE_MS) {
    return { ...previous, picks };
  }
  const score = previous === null ? 1 : previous.score * decay(at - previous.openedAt) + 1;
  return { openedAt: at, score, picks };
}

export const USE_BOOST_LIMIT = 2.5;

/**
 * How much use lifts a thread: 1 for a stale, never-opened thread, about 2 for
 * one active today, and up to 2.5 for threads opened often.
 */
export function threadUsageBoost(thread: ThreadSearchSubject, now: number): number {
  const recency = thread.activityAt === null ? 0 : decay(now - thread.activityAt);
  const opens = thread.opens ? thread.opens.score * decay(now - thread.opens.openedAt) : 0;
  return Math.min(USE_BOOST_LIMIT, 1 + recency + 0.5 * Math.log2(1 + opens));
}

export const REFERENCE_PREFIX_MIN = 8;

// A number is never cut short: ".../pull/2288" is not pull request 22889.
export const notCut = (text: string, end: number) => !DIGIT.test(text[end] ?? "");

// IDs and URLs have many word starts, so field matching would let short queries hit every thread.
// Require a long prefix, or any long part containing a digit. Both are ASCII; lowercasing suffices.
export function matchReference(
  normalizedQuery: string,
  thread: ThreadSearchSubject,
): SearchFieldsMatch | null {
  if (normalizedQuery.length < REFERENCE_PREFIX_MIN) return null;
  const anywhere = DIGIT.test(normalizedQuery);
  const matches = (reference: string) => {
    const folded = reference.toLowerCase();
    const at = folded.indexOf(normalizedQuery);
    // A pasted link may go on past the reference: ".../pull/22889/files".
    return anywhere
      ? (at !== -1 && notCut(folded, at + normalizedQuery.length)) ||
          (normalizedQuery.startsWith(folded) && notCut(normalizedQuery, folded.length))
      : at === 0;
  };
  return (thread.id && matches(thread.id)) ||
    thread.pullRequests?.some((pullRequest) => pullRequest.references?.some(matches))
    ? { quality: 0.6, strong: true, primaryRanges: [] }
    : null;
}

// Picks expire from the pick time; opening a thread another way must not extend their priority.
// They reorder word matches within a group, never the groups themselves.
export const PICK_WINDOW_MS = 21 * DAY_MS;
// The start of a picked query counts from three letters: "n" is too little to
// go on.
export const PICK_PREFIX_MIN_LENGTH = 3;

/** The latest pick of the thread for this query, while it lasts. */
export function activePick(
  thread: ThreadSearchSubject,
  normalizedQuery: string,
  now: number,
): ThreadOpenStats["picks"][number] | undefined {
  // Stored picks are cut to a length, so compare the query cut the same way.
  const query = pickedQuery(normalizedQuery);
  const prefix = query.length >= PICK_PREFIX_MIN_LENGTH;
  // The latest exact pick, else the latest pick the query starts.
  let exact: ThreadOpenStats["picks"][number] | undefined;
  let latest: ThreadOpenStats["picks"][number] | undefined;
  for (const pick of thread.opens?.picks ?? []) {
    if (now - pick.at > PICK_WINDOW_MS) continue;
    if (pick.query === query && (exact === undefined || pick.at > exact.at)) exact = pick;
    const matches = pick.query === query || (prefix && pick.query.startsWith(query));
    if (matches && (latest === undefined || pick.at > latest.at)) latest = pick;
  }
  return exact ?? latest;
}

export const WORKTREE_BRANCH_PREFIX_PATTERN = new RegExp(`^(?:${WORKTREE_BRANCH_PREFIX}|t3code)/(?=\\S)`);

export function searchableBranch(branch: string | null | undefined): string | null {
  return branch ? branch.replace(WORKTREE_BRANCH_PREFIX_PATTERN, "") : null;
}

/**
 * The field that explains a match whose title shows none: the first that holds
 * the whole query, else, past the words the project or environment holds, the
 * first that holds the rest ("lakebed perf" in project "lakebed" with the PR
 * title "perf: …").
 */
export function matchHint(
  normalizedQuery: string,
  thread: ThreadSearchSubject,
  typos: boolean,
): SearchMatchHint | undefined {
  const candidates: Array<{ readonly label: string; readonly text: string | null | undefined }> = [
    ...(thread.pullRequests ?? []).map((pullRequest) => ({
      label: "PR",
      text: `#${pullRequest.number}${pullRequest.title ? ` ${pullRequest.title}` : ""}`,
    })),
    { label: "Branch", text: searchableBranch(thread.branch) },
    { label: "Project", text: thread.projectTitle },
    { label: "Environment", text: thread.environmentLabel },
  ];
  const holds = (text: string, query: string) =>
    matchSearchFields(query, [{ value: text, weight: 1 }], { typos })?.primaryRanges;
  const hintFor = (query: string) => {
    for (const { label, text } of candidates) {
      const ranges = text ? holds(text, query) : undefined;
      if (text && ranges) return { label, text, ranges };
    }
    return undefined;
  };
  const whole = hintFor(normalizedQuery);
  if (whole) return whole;
  const contexts = [thread.projectTitle, thread.environmentLabel].filter(
    (text): text is string => !!text,
  );
  const rest = normalizedQuery
    .split(" ")
    .filter((token) => !contexts.some((text) => holds(text, token)))
    .join(" ");
  return rest && rest !== normalizedQuery ? hintFor(rest) : undefined;
}

// A keystroke scores each thread's fields again, so they are listed once per subject.
export const threadFieldsCache = new WeakMap<ThreadSearchSubject, ReadonlyArray<WeightedSearchField>>();

export function threadSearchFields(thread: ThreadSearchSubject): ReadonlyArray<WeightedSearchField> {
  const cached = threadFieldsCache.get(thread);
  if (cached) return cached;
  const fields: WeightedSearchField[] = [{ value: thread.title, weight: 1, midWord: true }];
  for (const pullRequest of thread.pullRequests ?? []) {
    fields.push({ value: `#${pullRequest.number}`, weight: 1 });
    if (pullRequest.title) fields.push({ value: pullRequest.title, weight: 0.5 });
  }
  const branch = searchableBranch(thread.branch);
  if (branch) fields.push({ value: branch, weight: 0.6 });
  if (thread.projectTitle) {
    fields.push({ value: thread.projectTitle, weight: 0.25, context: true });
  }
  if (thread.environmentLabel) {
    fields.push({ value: thread.environmentLabel, weight: 0.25, context: true });
  }
  threadFieldsCache.set(thread, fields);
  return fields;
}

export let lastFieldQuery: { readonly query: string; readonly fieldQuery: string } | undefined;

// Strip pull request prefixes and the worktree prefix so queries match the stored fields.
export function threadFieldQuery(normalizedQuery: string): string {
  if (lastFieldQuery?.query !== normalizedQuery) {
    lastFieldQuery = {
      query: normalizedQuery,
      fieldQuery: normalizedQuery
        .replace(/^(?:pr|pull request|pull)\s*(?=#?\d)/, "")
        .replace(/^#\s*/, "")
        .replace(WORKTREE_BRANCH_PREFIX_PATTERN, ""),
    };
  }
  return lastFieldQuery.fieldQuery;
}

/**
 * Scores a thread for a normalized query, or null when it does not match.
 * Titles and pull request numbers count fully, pull request titles and
 * branches less, project and environment names least.
 */
export function scoreThreadSearch(
  normalizedQuery: string,
  thread: ThreadSearchSubject,
  now: number,
  options?: {
    readonly typos?: boolean;
    /**
     * Palette picks; off where a pick would show up unexplained, such as a
     * sidebar filter or an agent's search.
     */
    readonly picks?: boolean;
  },
): ThreadSearchMatch | null {
  const fields = threadSearchFields(thread);
  const fieldQuery = threadFieldQuery(normalizedQuery);
  const fieldMatch = matchSearchFields(fieldQuery, fields, options);
  const referenceMatch = fieldMatch ? null : matchReference(normalizedQuery, thread);
  const match = fieldMatch ?? referenceMatch;
  if (match === null) return null;
  // A row whose title shows no match must say why. With several words, one
  // that cannot (its words spread over unrelated fields) is a coincidence and
  // is left out; a single word always sits in the field that matched it, so
  // its hint waits until the row is shown.
  const typos = options?.typos ?? false;
  const titleShowsMatch = match.primaryRanges.length > 0;
  const checkHint = !titleShowsMatch && referenceMatch === null && fieldQuery.includes(" ");
  const checkedHint = checkHint ? matchHint(fieldQuery, thread, typos) : undefined;
  if (checkHint && checkedHint === undefined) return null;
  const explain = titleShowsMatch
    ? undefined
    : (): SearchMatchHint | undefined =>
        referenceMatch
          ? { label: "ID or link", text: normalizedQuery, ranges: [] }
          : (checkedHint ?? matchHint(fieldQuery, thread, typos));
  const pick = options?.picks === false ? undefined : activePick(thread, normalizedQuery, now);
  return {
    score: match.quality * threadUsageBoost(thread, now),
    quality: match.quality,
    // A thread's whole title never lifts its group over a command or project
    // of that name: every new thread is titled "New thread" for a while.
    groupQuality: Math.min(match.quality, WHOLE_NAME - 0.01),
    strong: match.strong,
    ranges: match.primaryRanges,
    ...(explain ? { explain } : {}),
    ...(pick ? { pickedAt: pick.at } : {}),
    ...(pick?.query === pickedQuery(normalizedQuery) ? { pickedExactly: true } : {}),
  };
}

/** When the user last used a thread: their last message or their last open. */
export function threadRecentUse(thread: ThreadSearchSubject): number {
  return Math.max(thread.activityAt ?? 0, thread.opens?.openedAt ?? 0);
}

/**
 * How strongly a thread's messages match among matches of one quality: a
 * thread that keeps using the word outweighs a recent passing mention, as
 * hits count for more than recency or use (21 hits about 5.5, one hit 2).
 */
export function messageMatchWeight(hits: number): number {
  return 1 + Math.log2(1 + hits);
}

/** `withoutTitleMatches` reserves message rows for threads the palette has not already listed. */
export function rankMessageMatches<
  T extends {
    readonly quality?: number;
    readonly hits?: number;
    readonly messageCreatedAt?: string | null;
  },
>(
  matches: ReadonlyArray<T>,
  subjectOf: (match: T) => ThreadSearchSubject | undefined,
  normalizedQuery: string,
  now: number,
  options?: { readonly picks?: boolean; readonly withoutTitleMatches?: boolean },
): T[] {
  return matches
    .flatMap((match) => {
      const subject = subjectOf(match);
      if (!subject) return [];
      if (
        options?.withoutTitleMatches &&
        scoreThreadSearch(normalizedQuery, subject, now, { picks: false }) !== null
      ) {
        return [];
      }
      // Older servers send no quality; their matches count as words.
      const quality = match.quality ?? 1;
      return [
        {
          match,
          quality,
          pickedAt:
            options?.picks === false ? 0 : (activePick(subject, normalizedQuery, now)?.at ?? 0),
          score: messageMatchWeight(match.hits ?? 1) * threadUsageBoost(subject, now),
        },
      ];
    })
    .sort(
      (left, right) =>
        // Word matches first; among them a pick, then the closer match.
        Number(right.quality >= MESSAGE_PREFIX) - Number(left.quality >= MESSAGE_PREFIX) ||
        right.pickedAt - left.pickedAt ||
        right.quality - left.quality ||
        right.score - left.score ||
        (right.match.messageCreatedAt ?? "").localeCompare(left.match.messageCreatedAt ?? ""),
    )
    .map(({ match }) => match);
}

/** Palette limits shared by web and mobile. */
export const PALETTE_THREAD_LIMIT = 20;
export const PALETTE_MESSAGE_LIMIT = 10;
/** Next to matching threads, other groups show only their best few rows. */
export const PALETTE_SECONDARY_LIMIT = 3;

// Whole words and prefixes share a class so "Compact" does not lift settings over "Compaction".
export function matchClass(quality: number): number {
  return quality >= WHOLE_NAME ? 3 : quality >= 0.7 ? 2 : quality >= 0.4 ? 1 : 0;
}

export function rankSearchGroups<
  G,
  T,
  M extends {
    readonly score: number;
    readonly quality: number;
    readonly strong: boolean;
    readonly pickedAt?: number;
    readonly pickedExactly?: boolean;
    readonly groupQuality?: number;
  },
>(
  groups: ReadonlyArray<{ readonly group: G; readonly items: ReadonlyArray<T> }>,
  score: (item: T, options: { readonly typos: boolean }, group: G) => M | null,
): Array<{ readonly group: G; readonly ranked: ReadonlyArray<RankedSearchItem<T, M>> }> {
  const rank = (typos: boolean) =>
    groups.map(({ group, items }) => {
      const options = { typos };
      const ranked: Array<RankedSearchItem<T, M>> = [];
      for (const item of items) {
        const match = score(item, options, group);
        if (match !== null) ranked.push({ item, match });
      }
      return { group, ranked };
    });
  let ranked = rank(false);
  if (!ranked.some((entry) => entry.ranked.some(({ match }) => match.strong))) {
    ranked = rank(true);
  }
  return ranked
    .flatMap(({ group, ranked: items }, order) => {
      if (items.length === 0) return [];
      // Use cannot lift a project-only match above a title match or cross match classes.
      // Picks reorder word matches, keeping typos and mid-word hits below them.
      // A longer-query pick must not pass a whole-name match for the current query.
      const wordMatch = (match: M) => Math.min(matchClass(match.quality), 2);
      const exactPickAt = (match: M) => (match.pickedExactly ? (match.pickedAt ?? 0) : 0);
      const sorted = [...items].sort(
        (left, right) =>
          wordMatch(right.match) - wordMatch(left.match) ||
          exactPickAt(right.match) - exactPickAt(left.match) ||
          matchClass(right.match.quality) - matchClass(left.match.quality) ||
          (right.match.pickedAt ?? 0) - (left.match.pickedAt ?? 0) ||
          right.match.score - left.match.score,
      );
      const best = Math.max(
        ...items.map(({ match }) => matchClass(match.groupQuality ?? match.quality)),
      );
      return [{ group, ranked: sorted, best, order }];
    })
    .sort((left, right) => right.best - left.best || left.order - right.order)
    .map(({ group, ranked: items }) => ({ group, ranked: items }));
}

/** `rankSearchGroups` for a single list. */
export function rankSearchItems<
  T,
  M extends { readonly score: number; readonly quality: number; readonly strong: boolean },
>(
  items: ReadonlyArray<T>,
  score: (item: T, options: { readonly typos: boolean }) => M | null,
): ReadonlyArray<RankedSearchItem<T, M>> {
  return rankSearchGroups([{ group: null, items }], score)[0]?.ranked ?? [];
}

export const KEYWORD_QUALITY = 0.65;
// Below this, keyword prefixes match too much: "co" or "pro" would list most
// settings. A short query still matches a keyword it equals ("pr").
export const KEYWORD_QUERY_MIN_LENGTH = 4;

/**
 * Keywords count less so hidden terms cannot lift a group above a matching name.
 * Short queries need whole keywords to avoid listing most settings for common prefixes.
 */
export function scoreSearchTerms(
  normalizedQuery: string,
  terms: ReadonlyArray<string>,
  options?: { readonly typos?: boolean },
): SearchTermsMatch | null {
  // Filler words ("the ci") do not make a short query long.
  const meaningful = normalizedQuery
    .split(" ")
    .filter((token) => !FILLER_WORDS.has(token))
    .join(" ");
  const short = (meaningful || normalizedQuery).length < KEYWORD_QUERY_MIN_LENGTH;
  const match = matchSearchFields(
    normalizedQuery,
    terms.map((value, index) =>
      index === 0
        ? { value, weight: 1 }
        : // An alias typed in full ("pr") is deliberate, above a mere name prefix.
          { value, weight: short ? 0.8 : 0.6, wholeWords: short, keyword: true },
    ),
    options,
  );
  return (
    match && {
      score: match.quality,
      quality: match.quality,
      // Below the word-start class: a match only in hidden keywords must not put
      // its group above a result whose name matches. Inside the group an exact
      // alias still beats a name prefix ("pr" lists "Open pull requests" first).
      ...(match.primaryRanges.length > 0
        ? {}
        : { groupQuality: Math.min(match.quality, KEYWORD_QUALITY) }),
      strong: match.strong,
      ranges: match.primaryRanges,
    }
  );
}

