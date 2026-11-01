export type TextDirection = "ltr" | "rtl";

// Hebrew through Arabic Extended-A, their presentation forms, and the
// supplementary right-to-left blocks.
const RTL_LETTER = /[֐-ࣿיִ-﷿ﹰ-﻿\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const LETTER = /\p{L}/u;

/**
 * `dir="auto"` misreads Arabic prose that opens with an English term.
 * Count words so mixed prose follows its main language; break ties with the first word.
 */
export function textDirection(text: string): TextDirection | undefined {
  if (!RTL_LETTER.test(text)) return LETTER.test(text) ? "ltr" : undefined;
  let rtlWords = 0;
  let ltrWords = 0;
  let first: TextDirection | undefined;
  for (const word of text.split(/\s+/)) {
    const letter = LETTER.exec(word)?.[0];
    if (!letter) continue;
    const direction = RTL_LETTER.test(letter) ? "rtl" : "ltr";
    first ??= direction;
    if (direction === "rtl") rtlWords += 1;
    else ltrWords += 1;
  }
  if (rtlWords === ltrWords) return first;
  return rtlWords > ltrWords ? "rtl" : "ltr";
}

const MARKDOWN_CODE_OR_URL =
  /(`{3,}|~{3,})[\s\S]*?(?:\1|$)|(`{1,2})(?!`)[\s\S]*?(?<!`)\2(?!`)|https?:\/\/\S+/g;

export function markdownProseDirection(markdown: string): TextDirection | undefined {
  return textDirection(markdown.replace(MARKDOWN_CODE_OR_URL, " "));
}
