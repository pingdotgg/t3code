import {
  getSharedHighlighter,
  type DiffsHighlighter,
  type SupportedLanguages,
} from "@pierre/diffs";

import { resolveDiffThemeName } from "./diffRendering";
import { DEFAULT_THEME_PALETTE, type ThemePalette } from "./themePalettes";

const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();

/**
 * Keyed by palette as well as language: each palette carries its own pair of
 * syntax themes, and only the pair a palette actually needs is requested so
 * switching palettes does not pull every bundled theme into the page.
 * `getSharedHighlighter` attaches to one shared instance, so themes accumulate
 * across calls rather than replacing each other.
 */
export function getSyntaxHighlighterPromise(
  language: string,
  palette: ThemePalette = DEFAULT_THEME_PALETTE,
): Promise<DiffsHighlighter> {
  const cacheKey = `${palette}:${language}`;
  const cached = highlighterPromiseCache.get(cacheKey);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark", palette), resolveDiffThemeName("light", palette)],
    langs: [language as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  }).catch((error) => {
    if (language === "text") {
      highlighterPromiseCache.delete(cacheKey);
      // "text" itself failed — Shiki cannot initialize at all, surface the error
      throw error;
    }
    // Language not supported by Shiki — fall back to "text"
    return getSyntaxHighlighterPromise("text", palette);
  });
  highlighterPromiseCache.set(cacheKey, promise);
  return promise;
}
