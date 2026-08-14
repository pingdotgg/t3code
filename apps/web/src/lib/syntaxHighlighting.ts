import {
  getSharedHighlighter,
  type DiffsHighlighter,
  type SupportedLanguages,
} from "@pierre/diffs";

import type { DiffThemeName } from "./diffRendering";

const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();

export function getSyntaxHighlighterPromise(
  language: string,
  themeName: DiffThemeName,
): Promise<DiffsHighlighter> {
  const cacheKey = `${themeName}\0${language}`;
  const cached = highlighterPromiseCache.get(cacheKey);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [themeName],
    langs: [language as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  }).catch((error) => {
    if (language === "text") {
      highlighterPromiseCache.delete(cacheKey);
      // "text" itself failed — Shiki cannot initialize at all, surface the error
      throw error;
    }
    // Language not supported by Shiki — fall back to "text"
    return getSyntaxHighlighterPromise("text", themeName);
  });
  highlighterPromiseCache.set(cacheKey, promise);
  return promise;
}
