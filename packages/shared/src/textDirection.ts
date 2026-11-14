export type TextDirection = "ltr" | "rtl";

// Hebrew through Arabic Extended-A, their presentation forms, and the
// supplementary right-to-left blocks.
const RTL_LETTER = /[֐-ࣿיִ-﷿ﹰ-﻿\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const LETTER = /\p{L}/u;
const SENTENCE_END = /(?<=[.!?؟])(?<!\b(?:e\.g|i\.e)\.)\s+|\n+/i;

function majority(
  units: Iterable<TextDirection | undefined>,
  tieDirection?: () => TextDirection | undefined,
): TextDirection | undefined {
  let rtl = 0;
  let ltr = 0;
  let first: TextDirection | undefined;
  for (const direction of units) {
    if (!direction) continue;
    first ??= direction;
    if (direction === "rtl") rtl += 1;
    else ltr += 1;
  }
  if (rtl === ltr) return tieDirection ? tieDirection() : first;
  return rtl > ltr ? "rtl" : "ltr";
}

function wordDirection(word: string): TextDirection | undefined {
  const letter = LETTER.exec(word)?.[0];
  if (!letter) return undefined;
  return RTL_LETTER.test(letter) ? "rtl" : "ltr";
}

/**
 * `dir="auto"` misreads Arabic prose that opens with an English term.
 * Each sentence follows its main language by word count, and the text follows most of its
 * sentences, so one long English sentence cannot outvote the Arabic ones around it.
 * Sentence ties use the whole-text word majority, then the first word.
 */
export function textDirection(text: string): TextDirection | undefined {
  if (!RTL_LETTER.test(text)) return LETTER.test(text) ? "ltr" : undefined;
  return majority(
    text.split(SENTENCE_END).map((sentence) => majority(sentence.split(/\s+/).map(wordDirection))),
    () => majority(text.split(/\s+/).map(wordDirection)),
  );
}

const MARKDOWN_CODE_OR_URL =
  /(`{3,}|~{3,})[\s\S]*?(?:\1|$)|(`{1,2})(?!`)[\s\S]*?(?<!`)\2(?!`)|https?:\/\/\S+/g;

export function markdownProseDirection(markdown: string): TextDirection | undefined {
  return textDirection(markdown.replace(MARKDOWN_CODE_OR_URL, " "));
}

const PARAGRAPH_BREAK = /\r\n|[\n\r\u2029]/;
const CODE_FENCE = /^ {0,3}(?:`{3,}|~{3,})/;

/**
 * One direction per paragraph for a plain-text editor, by the composer's rule: a line without
 * letters continues the one above, code blocks and chips do not count. Empty unless some line
 * reads right to left, so a left-to-right draft is left to the platform.
 */
export function composerParagraphDirections(
  text: string,
  chips: ReadonlyArray<{ readonly start: number; readonly end: number }> = [],
): ReadonlyArray<TextDirection> {
  if (!RTL_LETTER.test(text)) return [];
  let prose = text;
  for (const chip of chips) {
    prose = prose.slice(0, chip.start) + " ".repeat(chip.end - chip.start) + prose.slice(chip.end);
  }
  let previous: TextDirection = "ltr";
  let inCode = false;
  const directions = prose.split(PARAGRAPH_BREAK).map((line) => {
    const fence = CODE_FENCE.test(line);
    if (fence) inCode = !inCode;
    if (fence || inCode) return "ltr";
    previous = markdownProseDirection(line) ?? previous;
    return previous;
  });
  return directions.includes("rtl") ? directions : [];
}
