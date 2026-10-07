// Hebrew through Arabic Extended-A, the Hebrew and Arabic presentation forms, and the
// supplementary-plane right-to-left scripts. Kept in step with `T3MarkdownTextDirection.h`.
const RIGHT_TO_LEFT_LETTER = /[֐-ࣿיִ-﷿ﹰ-﻿\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const LETTER = /\p{L}/u;

/**
 * The direction of the first letter in `text`, the way HTML's `dir="auto"` picks it, or
 * null when the text has no letters and should keep the direction it inherits.
 */
export function markdownTextDirection(text: string): "rtl" | "ltr" | null {
  for (const character of text) {
    if (LETTER.test(character)) {
      return RIGHT_TO_LEFT_LETTER.test(character) ? "rtl" : "ltr";
    }
  }
  return null;
}
