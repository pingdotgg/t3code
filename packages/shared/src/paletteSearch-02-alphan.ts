import { MESSAGE_PREFIX, rankSearchGroups, scoreSearchTerms, scoreThreadSearch } from "./paletteSearch-01-messag.ts";
import type { OrchestrationV2ThreadOpens } from "@t3tools/contracts";
/** Shared ranking keeps command palettes and MCP thread search consistent across surfaces. */

export const ALPHANUMERIC = /[\p{L}\p{N}]/u;
export const LOWERCASE = /\p{Ll}/u;
export const UPPERCASE = /\p{Lu}/u;
export const DIGIT = /\p{N}/u;
export const LETTER = /\p{L}/u;
export const COMBINING_MARKS = /\p{M}/gu;
// Emoji and other symbols can be searched for, so they start words too.
export const SYMBOL = /\p{So}/u;
export const APOSTROPHE = /['’]/;
export const CURLY_APOSTROPHES = /[\u2018\u2019]/g;

export interface SearchField {
  /** Case- and accent-folded text, one UTF-16 unit per source unit. */
  readonly text: string;
  /** 1 where a word starts in `text`. */
  readonly wordStarts: Uint8Array;
}

export interface SearchRange {
  readonly start: number;
  readonly end: number;
}

// Thread titles, branches, and project names repeat across keystrokes; folding
// them once keeps a keystroke to plain string scans. Each keystroke reads every
// field, so the limit must hold all of them or the cache clears every time; a
// field is a few bytes per character.
export const fieldCache = new Map<string, SearchField>();
export const FIELD_CACHE_LIMIT = 100_000;

export function foldCharacter(character: string): string {
  // A typed straight apostrophe finds a curly one: iOS keyboards type "’".
  return character
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace("ς", "σ")
    .replace(/[‘’]/, "'");
}

/**
 * `text` with case and accents folded one UTF-16 unit at a time, so offsets
 * and word starts still read from `text` and highlights need no mapping. A
 * letter that folds to more or less than one unit ("ß", "ﬁ") stays as it is.
 */
export function foldInPlace(text: string): string {
  return text
    .replace(/[\u0080-\uffff]/g, (character) => {
      const folded = foldCharacter(character);
      return folded.length === 1 ? folded : character;
    })
    .toLowerCase();
}

// Chinese and Japanese text has no spaces, so each ideograph or kana starts a word.
export function isCjk(character: string): boolean {
  const code = character.codePointAt(0)!;
  return (
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

// Two Chinese, Japanese, or Korean characters already make a common word.
export function hasCjkWord(token: string): boolean {
  return Array.from(token).some((character) => {
    const code = character.codePointAt(0)!;
    return isCjk(character) || (code >= 0xac00 && code <= 0xd7af);
  });
}

/**
 * Whether `character` starts a word after `previous` and `beforePrevious`
 * ("" at the start): after a non-letter, at a camelCase or digit boundary, or
 * at any Chinese or Japanese character. The one rule for titles and messages.
 */
export function isWordStart(
  beforePrevious: string,
  previous: string,
  character: string,
  next: string,
): boolean {
  // "Julius’s": a possessive or contraction does not start a word.
  const afterApostrophe = APOSTROPHE.test(previous) && ALPHANUMERIC.test(beforePrevious);
  return (
    (ALPHANUMERIC.test(character) || SYMBOL.test(character)) &&
    !afterApostrophe &&
    (previous === "" ||
      !ALPHANUMERIC.test(previous) ||
      (LOWERCASE.test(previous) && UPPERCASE.test(character)) ||
      // The last capital of an acronym starts the next word: "JSONSchema".
      (UPPERCASE.test(previous) && UPPERCASE.test(character) && LOWERCASE.test(next)) ||
      DIGIT.test(previous) !== DIGIT.test(character) ||
      isCjk(character))
  );
}

export function foldSearchField(source: string): SearchField {
  const wordStarts = new Uint8Array(source.length);
  const characters = Array.from(source);
  let index = 0;
  for (const [position, character] of characters.entries()) {
    const previous = characters[position - 1] ?? "";
    const next = characters[position + 1] ?? "";
    if (isWordStart(characters[position - 2] ?? "", previous, character, next)) {
      wordStarts[index] = 1;
    }
    index += character.length;
  }
  return { text: foldInPlace(source), wordStarts };
}

export function prepareSearchField(source: string): SearchField {
  const cached = fieldCache.get(source);
  if (cached) return cached;
  // Oldest first out. A read does not re-insert: that would cost more than the
  // fold it saves, and the limit holds far more fields than a keystroke reads.
  if (fieldCache.size >= FIELD_CACHE_LIMIT) {
    fieldCache.delete(fieldCache.keys().next().value!);
  }
  const field = foldSearchField(source);
  fieldCache.set(source, field);
  return field;
}

// Quotes around a pasted query: "fix sidebar".
export const WRAPPING_QUOTES = /^\s*["'`“”‘’]+|["'`“”‘’]+\s*$/g;

/** Folded, whitespace-collapsed query; empty when there is nothing to match. */
export function foldSearchQuery(query: string): string {
  return foldInPlace(query.replace(WRAPPING_QUOTES, "").normalize("NFC"))
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .join(" ");
}

export function wordEnd(field: SearchField, index: number): number {
  let end = index + 1;
  while (end < field.text.length && !field.wordStarts[end] && ALPHANUMERIC.test(field.text[end]!)) {
    end++;
  }
  return end;
}

// One substitution, insertion, deletion, or swap of neighbours; with
// `swapOnly`, only a swap.
export function withinOneEdit(left: string, right: string, swapOnly: boolean): boolean {
  if (Math.abs(left.length - right.length) > (swapOnly ? 0 : 1)) return false;
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index++;
  const restLeft = left.slice(index);
  const restRight = right.slice(index);
  const swapped =
    restLeft.length > 1 &&
    restLeft[0] === restRight[1] &&
    restLeft[1] === restRight[0] &&
    restLeft.slice(2) === restRight.slice(2);
  if (swapOnly) return swapped;
  return (
    swapped ||
    restLeft === restRight ||
    restLeft.slice(1) === restRight.slice(1) ||
    restLeft.slice(1) === restRight ||
    restLeft === restRight.slice(1)
  );
}

export const WHOLE_WORD = 1;
// The bonus for a field equal to the whole query lifts a whole word to this.
export const WHOLE_NAME = 1.5;
export const MID_WORD = 0.3;
export const TYPO = 0.45;
// Whole words typed together are exact, so they rank with typos and above
// mid-word hits, though below a match at a word start.
export const JOINED_WORDS = 0.6;

export interface TokenMatch extends SearchRange {
  readonly score: number;
  /** Separate ranges, for words typed together. */
  readonly letters?: ReadonlyArray<SearchRange>;
}

/**
 * Mid-word hits need four or more characters and `midWord`, so "del" does not find "model".
 * Typos preserve the first letter except for swaps; short tokens allow fewer edits to limit noise.
 * Numbers never match with a typo because different pull request numbers must stay distinct.
 */
export function matchToken(
  field: SearchField,
  token: string,
  typos: boolean,
  isPrimary: boolean,
  midWord: boolean,
): TokenMatch | null {
  if (token.length === 0) return null;
  let best: TokenMatch | null = null;
  let ownBoundary: boolean | undefined;
  for (
    let index = field.text.indexOf(token);
    index !== -1;
    index = field.text.indexOf(token, index + 1)
  ) {
    // A token that opens with punctuation (".ts") brings its own boundary, as in messages.
    if (
      field.wordStarts[index] ||
      (ownBoundary ??= !ALPHANUMERIC.test(token[0]!) && !SYMBOL.test(token[0]!))
    ) {
      // Whole when the match ends where a word ends: "t3c" is a prefix of
      // "t3code", ".ts" whole in "index.ts" but a prefix in "parser.tsx".
      const end = index + token.length;
      const whole =
        end >= field.text.length ||
        field.wordStarts[end] === 1 ||
        !ALPHANUMERIC.test(field.text[end]!);
      let runEnd = end;
      while (runEnd < field.text.length && ALPHANUMERIC.test(field.text[runEnd]!)) runEnd++;
      const score = whole ? WHOLE_WORD : 0.7 + (0.2 * token.length) / (runEnd - index);
      if (best === null || score > best.score) {
        best = { score, start: index, end: index + token.length };
      }
      if (score === WHOLE_WORD) return best;
    } else if (midWord && token.length >= 4 && best === null) {
      best = { score: MID_WORD, start: index, end: index + token.length };
    }
  }
  // Joined words are exact, so they count without the typo pass: a strong
  // match elsewhere must not hide "VS Code" for "vscode".
  if ((best === null || best.score <= MID_WORD) && isPrimary) {
    const joined = matchJoinedWords(field, token);
    if (joined) return joined;
  }
  if ((best !== null && best.score > MID_WORD) || !typos || token.length < 3) return best;
  // Numbers skip typos to keep pull requests distinct. Words with digits ("t3code") do not.
  if (LETTER.test(token)) {
    for (let index = 0; index < field.text.length; index++) {
      if (!field.wordStarts[index]) continue;
      // People rarely mistype the first letter, so a typo keeps it, unless it
      // swaps the first two of a longer word ("ing" is not "nig…").
      const first = field.text[index];
      const firstLetterKept =
        first === token[0] ||
        (token.length > 3 && first === token[1] && field.text[index + 1] === token[0]);
      if (!firstLetterKept) continue;
      // The whole run, across camelCase joins: "githbu" is "GitHub".
      let runEnd = index + 1;
      while (runEnd < field.text.length && ALPHANUMERIC.test(field.text[runEnd]!)) runEnd++;
      const word = field.text.slice(index, runEnd);
      // Short tokens forgive a swapped pair or one missing letter ("srv" for
      // "serv…"); any other edit of a three- or four-letter word matches too
      // much ("cron" would find every "con…").
      const short = token.length <= 4;
      // The same length first, so "githbu" highlights all of "GitHub".
      const lengths = short
        ? [token.length, token.length + 1]
        : [token.length, token.length - 1, token.length + 1];
      for (const length of lengths) {
        if (length > word.length) continue;
        const prefix = word.slice(0, length);
        if (withinOneEdit(token, prefix, short && length === token.length)) {
          return { score: TYPO, start: index, end: index + length };
        }
      }
    }
  }
  return best;
}

/**
 * Short words followed by a short prefix are noise inside a title ("inth" in "in thread").
 * Allow them at its start ("t3co"), before three letters ("gomod"), or a whole word ("vscode").
 */
export function matchJoinedWords(field: SearchField, token: string): TokenMatch | null {
  for (
    let start = field.text.indexOf(token[0]!);
    start !== -1;
    start = field.text.indexOf(token[0]!, start + 1)
  ) {
    if (!field.wordStarts[start]) continue;
    const runs: SearchRange[] = [];
    let at = start;
    let rest = token;
    while (rest.length > 0 && at < field.text.length) {
      const end = wordEnd(field, at);
      if (rest.length <= end - at && field.text.startsWith(rest, at)) {
        runs.push({ start: at, end: at + rest.length });
        rest = "";
      } else if (rest.startsWith(field.text.slice(at, end))) {
        runs.push({ start: at, end });
        rest = rest.slice(end - at);
        at = end;
        while (at < field.text.length && !field.wordStarts[at]) at++;
      } else {
        break;
      }
    }
    const last = runs.at(-1);
    if (rest.length > 0 || last === undefined || runs.length < 2) continue;
    if (
      last.end === wordEnd(field, last.start) ||
      last.end - last.start >= 3 ||
      start === field.wordStarts.indexOf(1) ||
      runs.slice(0, -1).every((run) => run.end - run.start >= 3)
    ) {
      return { score: JOINED_WORDS, start, end: last.end, letters: runs };
    }
  }
  return null;
}

export interface WeightedSearchField {
  readonly value: string;
  /** `value` folded; set on first use, so fields kept across keystrokes fold once. */
  prepared?: SearchField;
  readonly weight: number;
  /** Only a whole-word match counts, as for a short query against keywords. */
  readonly wholeWords?: boolean;
  /**
   * Only a match at a word start counts, without typos: hidden keywords that
   * matched loosely would list results the user cannot see why for.
   */
  readonly keyword?: boolean;
  /**
   * Where the thread lives (project, environment): it helps a match, but a
   * word start there does not make the match strong, so it never turns off
   * joined words or typos for the titles.
   */
  readonly context?: boolean;
  /**
   * A token of four or more letters may match inside a word here. Only thread
   * titles allow it: inside a command name or a branch it reads as junk
   * ("arch" in "Search").
   */
  readonly midWord?: boolean;
}

export interface SearchFieldsMatch {
  /** Roughly 0.3 (inside a word) to 1.5 (exact title). */
  readonly quality: number;
  /** Every token matched at a word start, without a typo. */
  readonly strong: boolean;
  /** Source ranges matched in the first field, for highlighting. */
  readonly primaryRanges: ReadonlyArray<SearchRange>;
}

export function preparedField(weighted: WeightedSearchField): SearchField {
  return (weighted.prepared ??= prepareSearchField(weighted.value));
}

export const FILLER_WORDS = new Set(["a", "an", "and", "for", "in", "of", "on", "the", "to", "with"]);

// Sorted, with overlapping ranges joined.
export function mergeRanges(ranges: ReadonlyArray<SearchRange>): SearchRange[] {
  const merged: SearchRange[] = [];
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) };
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

// A keystroke scores every thread for one query, so its tokens are split once.
export let lastQuery:
  | { readonly query: string; readonly tokens: string[]; readonly fillerOptional: boolean }
  | undefined;

export function queryTokens(normalizedQuery: string) {
  if (lastQuery?.query !== normalizedQuery) {
    const tokens = normalizedQuery.split(" ").filter((token) => token.length > 0);
    // A phrase-style query ("fix the sidebar") carries filler words a name may
    // leave out; they count where they match but are not required.
    lastQuery = {
      query: normalizedQuery,
      tokens,
      fillerOptional: tokens.some((token) => !FILLER_WORDS.has(token)),
    };
  }
  return lastQuery;
}

/**
 * Every query token must match some field. Quality is the mean of each token's
 * best weighted match, plus a bonus when the first field holds the whole query
 * as a phrase or equals it.
 */
export function matchSearchFields(
  normalizedQuery: string,
  fields: ReadonlyArray<WeightedSearchField>,
  options?: { readonly typos?: boolean },
): SearchFieldsMatch | null {
  if (normalizedQuery.length === 0) return null;
  const primary = fields[0]?.value ? preparedField(fields[0]) : undefined;
  // An empty token would match everywhere, and loop forever in `matchToken`.
  const { tokens, fillerOptional } = queryTokens(normalizedQuery);
  if (tokens.length === 0) return null;
  const primaryRanges: SearchRange[] = [];
  let total = 0;
  let counted = 0;
  let strong = true;
  for (const token of tokens) {
    let best = 0;
    let bestPrimary: TokenMatch | null = null;
    let atWordStart = false;
    for (const weighted of fields) {
      if (weighted.value.length === 0) continue;
      const { weight, wholeWords, keyword, context, midWord } = weighted;
      const field = preparedField(weighted);
      if (best >= weight && field !== primary && atWordStart) continue;
      const typos = (options?.typos ?? false) && !keyword;
      // Joined words only count in the name.
      const match = matchToken(field, token, typos, field === primary, midWord ?? false);
      if (match === null || match.score < (wholeWords ? WHOLE_WORD : keyword ? 0.7 : 0)) continue;
      if (field === primary) bestPrimary = match;
      if (match.score >= 0.7 && !context) atWordStart = true;
      if (match.score * weight > best) best = match.score * weight;
    }
    if (best === 0) {
      if (fillerOptional && FILLER_WORDS.has(token)) continue;
      return null;
    }
    strong &&= atWordStart;
    if (bestPrimary) primaryRanges.push(...(bestPrimary.letters ?? [bestPrimary]));
    total += best;
    counted += 1;
  }
  let quality = total / counted;
  if (primary) {
    if (primary.text === normalizedQuery) quality += WHOLE_NAME - WHOLE_WORD;
    else if (tokens.length > 1 && primary.text.includes(normalizedQuery)) quality += 0.25;
  }
  return {
    quality,
    strong,
    primaryRanges: mergeRanges(primaryRanges),
  };
}

// A two-letter Latin substring of a message is noise rather than a match.
export const MESSAGE_TOKEN_MIN_LENGTH = 3;

/**
 * Keep accents: the server index folds Latin accents, and stripping marks breaks Korean/Japanese.
 * Every `long` token must match; `short` tokens only narrow hits. No long tokens means no search.
 * Two CJK characters count as long.
 */
export function messageSearchTokens(query: string): {
  readonly long: ReadonlyArray<string>;
  readonly short: ReadonlyArray<string>;
  /** Every token, in the order typed. */
  readonly words: ReadonlyArray<string>;
} {
  const tokens = query
    .replace(WRAPPING_QUOTES, "")
    // The index stores apostrophes straight, as `indexedMessageText` writes them.
    .replace(CURLY_APOSTROPHES, "'")
    .normalize("NFC")
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  const searchable = (token: string) => {
    const length = Array.from(token).length;
    return length >= MESSAGE_TOKEN_MIN_LENGTH || (length === 2 && hasCjkWord(token));
  };
  return {
    long: tokens.filter(searchable),
    short: tokens.filter((token) => !searchable(token)),
    words: tokens,
  };
}

/**
 * Matches the query's words side by side as whole words, as typed, whatever
 * whitespace is between them and ignoring case; null for a single word.
 */
export function messagePhrase(query: string): RegExp | null {
  const { words } = messageSearchTokens(query);
  return words.length > 1
    ? new RegExp(
        `(?<![\\p{L}\\p{N}])${words
          .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("\\s+")}(?![\\p{L}\\p{N}])`,
        "iu",
      )
    : null;
}

// Words written together, as typed, rank above the same words apart, as in
// titles; words near each other rank above words far apart.
export const MESSAGE_PHRASE_BONUS = 0.25;
export const MESSAGE_NEAR_BONUS = 0.1;
// About what a result row shows.
export const MESSAGE_NEAR_SPAN = 60;

export const NON_ASCII = /[\u0080-\uffff]/;
// A message token shorter than this must start a word: "fts" is not in "drafts".
export const MESSAGE_WORD_START_LENGTH = 4;
export interface MessageMatch {
  /**
   * 1 when every searched word is a whole word, MESSAGE_PREFIX when one only
   * starts a word ("mode" in "model"), MID_WORD when one only appears inside
   * words, plus MESSAGE_PHRASE_BONUS when the words are written together as
   * typed, else MESSAGE_NEAR_BONUS when they sit within a row's width.
   */
  readonly quality: number;
  /** Where a snippet should start to show the match. */
  readonly offset: number;
}

/**
 * Grades messages against a query, so message hits rank like titles: null
 * when a token is missing or a short one never starts a word ("fts" in
 * "drafts"). Case and accents are ignored, as in the server's index. The
 * query is prepared once, since the server grades thousands of hits for it.
 */
export interface SearchTextPart {
  readonly text: string;
  readonly highlighted: boolean;
  readonly start: number;
}

/** `text` cut into plain and highlighted parts at sorted, non-overlapping `ranges`. */
export type ThreadOpenStats = OrchestrationV2ThreadOpens;

/**
 * Next open stats after an open at `at`. `query` is the palette query that
 * picked the thread, when it was opened from search.
 */
export interface ThreadSearchSubject {
  /** Matched only by the whole query, like references. */
  readonly id?: string;
  readonly title: string;
  readonly branch?: string | null;
  readonly projectTitle?: string | null;
  /** Only set with two or more environments; it tells same-named threads apart. */
  readonly environmentLabel?: string | null;
  readonly pullRequests?: ReadonlyArray<{
    readonly number: number;
    readonly title?: string | null;
    /** Values such as URLs, matched only by the whole query. */
    readonly references?: ReadonlyArray<string>;
  }>;
  /** Latest user activity, in epoch ms. */
  readonly activityAt: number | null;
  readonly opens?: ThreadOpenStats | null;
}

// Use reorders matches of about the same quality but never turns a mid-word
// hit on a busy thread into a better result than a whole word on a quiet one.
export interface ThreadSearchMatch {
  /** Match quality times use; what results sort by. */
  readonly score: number;
  /** Match quality alone; see `rankSearchGroups`. */
  readonly quality: number;
  /** Every token matched at a word start; see `rankSearchGroups`. */
  readonly strong: boolean;
  /** Matched ranges in the title. */
  readonly ranges: ReadonlyArray<SearchRange>;
  /**
   * Why the thread matched when its title shows no match, for the result row.
   * Built on demand, so only the rows shown pay for it.
   */
  readonly explain?: () => SearchMatchHint | undefined;
  /** When the thread was picked for this query, while that pick lasts; see `rankSearchGroups`. */
  readonly pickedAt?: number;
  /** Picked for exactly this query, before newer picks for longer ones; see `rankSearchGroups`. */
  readonly pickedExactly?: boolean;
  /** Below the whole-name class; see `scoreThreadSearch`. */
  readonly groupQuality: number;
}

export interface SearchMatchHint {
  readonly label: string;
  readonly text: string;
  readonly ranges: ReadonlyArray<SearchRange>;
}

// Most threads' branches start with the app's own worktree prefix ("t3/", and
// "t3code/" before it), so "t3 connect" would match nearly every thread.
// Only before more text, so typing "t3/" does not empty the list for a keystroke.
export interface RankedSearchItem<T, M> {
  readonly item: T;
  readonly match: M;
}

/**
 * Rank groups by match class to keep typing stable and thread use from outweighing equal commands.
 * Try typos only without word-start matches: they add noise beside real matches and cost per key.
 */
export interface SearchTermsMatch {
  readonly score: number;
  readonly quality: number;
  /** The quality its group ranks by, when lower; see `scoreSearchTerms`. */
  readonly groupQuality?: number;
  readonly strong: boolean;
  readonly ranges: ReadonlyArray<SearchRange>;
}

