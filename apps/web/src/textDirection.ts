export type TextDirection = "ltr" | "rtl";

// Hebrew through Arabic Extended-A, their presentation forms, and the
// supplementary right-to-left blocks.
const RTL_LETTER = /[֐-ࣿיִ-﷿ﹰ-﻿\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const LETTER = /\p{L}/u;

/**
 * The base direction for a block of prose, or undefined when it has no letters.
 *
 * `dir="auto"` follows the first letter, which lays out an Arabic line that
 * opens with an English term (`StrictMode: يعيد الـ render مرتين`) left to
 * right, and developers write that way constantly. Counting words keeps such a
 * line right to left, while English with one quoted Arabic word stays left to
 * right. A tie goes to the first word, as `dir="auto"` would.
 */
export function textDirection(text: string): TextDirection | undefined {
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
