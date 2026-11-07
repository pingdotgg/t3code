import { resolveExternalWebLinkHost } from "./components/chat/externalLinkContextMenu";

export interface ComposerLink {
  readonly from: number;
  readonly to: number;
  readonly host: string;
}

// Mirrors GFM's autolink literals in the sent message: an http(s) URL not
// glued to a preceding letter, minus trailing punctuation and unbalanced `)`.
const URL_PATTERN = /(?<![A-Za-z])https?:\/\/[^\s<]+/giu;
const TRAILING_PUNCTUATION = new Set(["!", '"', "'", "*", ",", ".", ":", ";", "?", "]", "_", "~"]);

function trimLinkEnd(url: string): string {
  let unbalancedCloses = 0;
  for (const character of url) {
    if (character === "(") unbalancedCloses -= 1;
    else if (character === ")") unbalancedCloses += 1;
  }
  let end = url.length;
  while (end > 0) {
    const character = url[end - 1]!;
    if (character === ";") {
      // GFM drops an entity-like `&name;` suffix whole, not just its `;`.
      let nameStart = end - 1;
      while (nameStart > 0 && /[A-Za-z]/.test(url[nameStart - 1]!)) nameStart -= 1;
      if (nameStart < end - 1 && url[nameStart - 1] === "&") {
        end = nameStart - 1;
        continue;
      }
    }
    if (character === ")" && unbalancedCloses > 0) unbalancedCloses -= 1;
    else if (!TRAILING_PUNCTUATION.has(character)) break;
    end -= 1;
  }
  return url.slice(0, end);
}

export function findComposerLinks(text: string): ComposerLink[] {
  const links: ComposerLink[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimLinkEnd(match[0]);
    const host = resolveExternalWebLinkHost(url);
    if (host) links.push({ from: match.index, to: match.index + url.length, host });
  }
  return links;
}
