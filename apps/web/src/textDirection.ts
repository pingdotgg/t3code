export type TextDirection = "ltr" | "rtl";

// Hebrew through Arabic Extended-A, their presentation forms, and the
// supplementary right-to-left blocks.
const RTL_LETTER = /[֐-ࣿיִ-﷿ﹰ-﻿\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const LETTER = /\p{L}/u;
const SENTENCE_END = /(?<=[.!?؟])(?<!\b(?:e\.g|i\.e)\.)\s+|\n+/i;

function majority(units: Iterable<TextDirection | undefined>): TextDirection | undefined {
  let rtl = 0;
  let ltr = 0;
  let first: TextDirection | undefined;
  for (const direction of units) {
    if (!direction) continue;
    first ??= direction;
    if (direction === "rtl") rtl += 1;
    else ltr += 1;
  }
  if (rtl === ltr) return first;
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
 * Ties go to whichever comes first.
 */
export function textDirection(text: string): TextDirection | undefined {
  if (!RTL_LETTER.test(text)) return LETTER.test(text) ? "ltr" : undefined;
  return majority(
    text.split(SENTENCE_END).map((sentence) => majority(sentence.split(/\s+/).map(wordDirection))),
  );
}
