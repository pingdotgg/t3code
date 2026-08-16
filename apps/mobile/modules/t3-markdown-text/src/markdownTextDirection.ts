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
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Adlam}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Hanifi_Rohingya}\p{Script=Yezidi}]/u;

/**
 * A left-to-right block says so rather than staying silent: Yoga inherits `direction`, so an
 * English item under an Arabic one would otherwise keep its parent's mirrored chrome. Only a
 * block with no letter at all — a bare number, a lone link — is left to inherit.
 */
export function markdownTextDirection(text: string): "ltr" | "rtl" | undefined {
  const firstLetter = FIRST_LETTER.exec(text)?.[0];
  if (!firstLetter) return undefined;
  return RIGHT_TO_LEFT_LETTER.test(firstLetter) ? "rtl" : "ltr";
}

export function markdownNodeDirection(node: MarkdownNode): "ltr" | "rtl" | undefined {
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
