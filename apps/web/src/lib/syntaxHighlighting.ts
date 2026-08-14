import {
  getSharedHighlighter,
  type DiffsHighlighter,
  type SupportedLanguages,
} from "@pierre/diffs";

import type { DiffThemeName } from "./diffRendering";

const MAX_HIGHLIGHTER_PROMISES = 128;
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
    if (language === "text") throw error;
    // Language not supported by Shiki — fall back to "text"
    return getSyntaxHighlighterPromise("text", themeName);
  });
  highlighterPromiseCache.set(cacheKey, promise);
  if (highlighterPromiseCache.size > MAX_HIGHLIGHTER_PROMISES) {
    const oldestKey = highlighterPromiseCache.keys().next().value;
    if (oldestKey !== undefined) highlighterPromiseCache.delete(oldestKey);
  }
  void promise.catch(() => {
    if (highlighterPromiseCache.get(cacheKey) === promise) {
      highlighterPromiseCache.delete(cacheKey);
    }
  });
  return promise;
}
