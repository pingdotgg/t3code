import {
  getSharedHighlighter,
  type DiffsHighlighter,
  type SupportedLanguages,
} from "@pierre/diffs";

const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();

function highlighterCacheKey(language: string, themeName: string): string {
  return `${language}:${themeName}`;
}

export function getSyntaxHighlighterPromise(
  language: string,
  themeName: string,
): Promise<DiffsHighlighter> {
  const cacheKey = highlighterCacheKey(language, themeName);
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
