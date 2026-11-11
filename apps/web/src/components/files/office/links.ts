// Adapted from opencode (MIT). Copyright (c) 2025 opencode. See LICENSE.opencode.
import type { WordLink } from "./word-protocol";

/** The schemes the host opens outside the app; it refuses any other, such as `javascript:`, `file:` or `tel:`. */
const schemes = new Set(["http:", "https:", "mailto:"]);

/** A document's link address, normalized, when the host may open it; undefined otherwise, so the link stays text. */
export function externalUrl(href: string) {
  const url = URL.parse(href);

  return url && schemes.has(url.protocol) ? url.href : undefined;
}

/** Where a Word link leads, if it is one a reader may follow: a bookmark in the document, or an `externalUrl`. */
export function wordLink(href: string | undefined): WordLink | undefined {
  if (!href) return undefined;

  if (href.startsWith("#"))
    return href.length > 1 ? { kind: "internal", bookmark: href.slice(1) } : undefined;

  const url = externalUrl(href);

  return url ? { kind: "external", url } : undefined;
}
