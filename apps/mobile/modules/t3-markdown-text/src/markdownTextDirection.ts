/**
 * The web client hands each markdown block to the browser with `dir="auto"` and lets it pick a
 * direction from the first strong character. React Native has no equivalent: Yoga will not
 * mirror a row or resolve start/end padding without an explicit `direction`, so the same rule is
 * applied here by hand, per block, to keep the two clients reading alike.
 *
 * Text itself needs no help — iOS resolves natural alignment from the paragraph's own base
 * writing direction and Android's default text direction is first-strong. This is only for the
 * chrome around the text: a list marker and a quote rail have to be told which side they are on.
 */

import type { MarkdownNode } from "react-native-nitro-markdown/headless";

const FIRST_LETTER = /\p{L}/u;

/**
 * The living right-to-left scripts, which is where the first-strong rule earns its keep. Not the
 * full Unicode R/AL bidi classes — those are not expressible as a property escape in JS — but
 * every script a message is realistically written in.
 */
const RIGHT_TO_LEFT_LETTER =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Adlam}]/u;

/** `undefined` rather than `"ltr"` so a left-to-right block simply inherits and nothing moves. */
export function markdownTextDirection(text: string): "rtl" | undefined {
  const firstLetter = FIRST_LETTER.exec(text)?.[0];
  return firstLetter && RIGHT_TO_LEFT_LETTER.test(firstLetter) ? "rtl" : undefined;
}

export function markdownNodeDirection(node: MarkdownNode): "rtl" | undefined {
  return markdownTextDirection(markdownNodeText(node));
}

function markdownNodeText(node: MarkdownNode): string {
  if (node.content !== undefined) {
    return node.content;
  }
  // Stops at the first block that reads as text; a marker's own direction comes from its item.
  for (const child of node.children ?? []) {
    const text = markdownNodeText(child);
    if (FIRST_LETTER.test(text)) {
      return text;
    }
  }
  return "";
}
