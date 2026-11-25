import type { SpeechSynthesisWord } from "@t3tools/contracts";

/** A word speech recognition heard, in seconds from the start of the audio it was given. */
export type HeardWord = {
  readonly text: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
};

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
// How much text a window of speech can cover: spelled-out numbers make speech longer than its
// text, so a little over the heard length suffices, and less text leaves less to match by chance.
const TEXT_PER_HEARD_CHARACTER = 1.2;
const TEXT_SLACK = 40;
const MATCH_SCORE = 2;
const SKIP_COST = 1;

/** The whitespace-separated words of `text`, as UTF-16 offsets. */
export function textWords(text: string) {
  return [...text.matchAll(/\S+/g)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/** Letters and digits only, lowercased and without accents, so "ThreadList.tsx" meets "threadlist tsx". */
function foldedCharacters(word: string) {
  const folded: string[] = [];
  for (const character of word.normalize("NFD").toLowerCase())
    if (LETTER_OR_DIGIT.test(character)) folded.push(character);
  return folded;
}

/**
 * Times the text words from `from` onward that `heard` speaks, by aligning their characters. Spelled numbers and symbols the voice read differently match nothing and
 * are left for interpolation. Returns each matched word's start, keyed by word index, and how
 * many of the heard characters the text accounts for.
 */
export function matchHeardWords(
  text: string,
  words: ReadonlyArray<{ readonly start: number; readonly end: number }>,
  from: number,
  heard: ReadonlyArray<HeardWord>,
) {
  const heardCharacters: string[] = [];
  const heardTimes: number[] = [];
  for (const word of heard) {
    const characters = foldedCharacters(word.text);
    characters.forEach((character, index) => {
      heardCharacters.push(character);
      heardTimes.push(
        word.startSeconds +
          ((word.endSeconds - word.startSeconds) * index) / Math.max(characters.length, 1),
      );
    });
  }
  const textCharacters: string[] = [];
  const owners: number[] = [];
  const limit = heardCharacters.length * TEXT_PER_HEARD_CHARACTER + TEXT_SLACK;
  for (let index = from; index < words.length && textCharacters.length < limit; index++) {
    const word = words[index]!;
    for (const character of foldedCharacters(text.slice(word.start, word.end))) {
      textCharacters.push(character);
      owners.push(index);
    }
  }
  const starts = new Map<number, number>();
  const rows = textCharacters.length;
  const columns = heardCharacters.length;
  if (!rows || !columns) return { starts, matched: 0, heard: columns };
  // Best score aligning text[row:] with heard[column:]. Skipping a character costs, so a run of
  // matches beats the same letters scattered, and spelled-out numbers stay unmatched rather than
  // lending their letters to later words. Text left after the heard speech is free: the window
  // may end mid-reply.
  const scores = new Int32Array((rows + 1) * (columns + 1));
  const at = (row: number, column: number) => row * (columns + 1) + column;
  for (let column = 0; column < columns; column++)
    scores[at(rows, column)] = (column - columns) * SKIP_COST;
  for (let row = rows - 1; row >= 0; row--)
    for (let column = columns - 1; column >= 0; column--)
      scores[at(row, column)] = Math.max(
        textCharacters[row] === heardCharacters[column]
          ? scores[at(row + 1, column + 1)]! + MATCH_SCORE
          : -Infinity,
        scores[at(row + 1, column)]! - SKIP_COST,
        scores[at(row, column + 1)]! - SKIP_COST,
      );
  // Per word: matched characters and the heard characters they span.
  const matches = new Map<number, { count: number; first: number; last: number }>();
  let row = 0;
  let column = 0;
  let matched = 0;
  while (row < rows && column < columns) {
    const score = scores[at(row, column)]!;
    if (
      textCharacters[row] === heardCharacters[column] &&
      score === scores[at(row + 1, column + 1)]! + MATCH_SCORE
    ) {
      matched++;
      const owner = owners[row]!;
      const match = matches.get(owner);
      if (match) {
        match.count++;
        match.last = column;
      } else matches.set(owner, { count: 1, first: column, last: column });
      row++;
      column++;
    } else if (score === scores[at(row, column + 1)]! - SKIP_COST) column++;
    else row++;
  }
  // A word counts as heard only when most of its characters matched close together. Letters
  // borrowed from words the text spells differently, such as "three hundred" for "300", do not.
  const lengthsByWord = new Map<number, number>();
  for (const owner of owners) lengthsByWord.set(owner, (lengthsByWord.get(owner) ?? 0) + 1);
  for (const [owner, match] of matches) {
    const length = lengthsByWord.get(owner)!;
    // Short words recur everywhere, so they must match whole and in one piece.
    const solid =
      length <= 3
        ? match.count === length && match.last - match.first === length - 1
        : match.count / length >= 0.6 && match.last - match.first < length * 1.5 + 2;
    if (solid) starts.set(owner, heardTimes[match.first]!);
  }
  return { starts, matched, heard: columns };
}

/**
 * Spreads words over `durationSeconds` by length, with longer pauses after punctuation. The
 * fallback when no word timings exist for a stretch of audio.
 */
export function estimateWords(
  text: string,
  words: ReadonlyArray<{ readonly start: number; readonly end: number }>,
  startSeconds: number,
  endSeconds: number,
): SpeechSynthesisWord[] {
  const weights = words.map(({ start, end }) => {
    const word = text.slice(start, end);
    return (
      word.length + 1 + (/[.!?。！？]$/u.test(word) ? 4 : /[,;:，、；：]$/u.test(word) ? 2 : 0)
    );
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const span = Math.max(endSeconds - startSeconds, 0);
  let elapsed = 0;
  return words.map((word, index) => {
    const start = startSeconds + (elapsed / total) * span;
    elapsed += weights[index]!;
    return { ...word, startSeconds: start, endSeconds: startSeconds + (elapsed / total) * span };
  });
}
