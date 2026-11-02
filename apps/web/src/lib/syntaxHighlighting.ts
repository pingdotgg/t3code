import "@t3tools/client-runtime/assembly-highlighting";
import {
  getSharedHighlighter,
  setCustomExtension,
  type DiffsHighlighter,
  type HighlighterTypes,
  type SupportedLanguages,
} from "@pierre/diffs";

import type { DiffThemeNames } from "./diffRendering";

// Highlights has no lexer for these dialects, so they use their base language's.
setCustomExtension("luau", "lua");
setCustomExtension("xsl", "xml");
setCustomExtension("xslt", "xml");

/**
 * Highlights' hand-written WASM lexers tokenize large files 10-40x faster than
 * Shiki and never backtrack like Shiki's JS regex engine. Only one highlighter
 * type can be active per thread, so every creation site must pass this value.
 */
export const PREFERRED_HIGHLIGHTER: HighlighterTypes = "highlights";

const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();

export function getSyntaxHighlighterPromise(
  language: string,
  themes: DiffThemeNames,
): Promise<DiffsHighlighter> {
  const key = `${language}\0${themes.light}\0${themes.dark}`;
  const cached = highlighterPromiseCache.get(key);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    // Both palettes, so switching appearance never needs a new highlighter.
    themes: [themes.light, themes.dark],
    langs: [language as SupportedLanguages],
    preferredHighlighter: PREFERRED_HIGHLIGHTER,
  }).catch((error) => {
    if (language === "text") {
      highlighterPromiseCache.delete(key);
      throw error;
    }
    return getSyntaxHighlighterPromise("text", themes);
  });
  highlighterPromiseCache.set(key, promise);
  return promise;
}
