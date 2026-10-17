import type { DiffsHighlighter, HighlighterTypes, SupportedLanguages } from "@pierre/diffs";

import { resolveDiffThemeName } from "./diffRendering";

/**
 * Always highlight with the Oniguruma WASM engine — the JS regex engine can
 * backtrack catastrophically and hang the tokenizing thread. The shared
 * highlighter is a first-caller-wins singleton, so every creation site must
 * pass this value.
 */
export const PREFERRED_HIGHLIGHTER: HighlighterTypes = "shiki-wasm";

const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();

export function getSyntaxHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  // Shiki and its engines load with the first highlight, not with the app.
  const promise = import("./sharedHighlighter")
    .then(({ getSharedHighlighter }) =>
      getSharedHighlighter({
        themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
        langs: [language as SupportedLanguages],
        preferredHighlighter: PREFERRED_HIGHLIGHTER,
      }),
    )
    .catch((error) => {
      if (language === "text") {
        // "text" itself failed — Shiki cannot initialize at all, surface the error
        throw error;
      }
      // Language not supported by Shiki — fall back to "text"
      return getSyntaxHighlighterPromise("text");
    });
  // A failure stays cached too. Callers pass this promise to React `use()`, which needs the
  // same promise on every render to reach the error boundary's plain-text fallback, and
  // Chromium caches a failed dynamic import, so a retry of the same chunk cannot succeed.
  highlighterPromiseCache.set(language, promise);
  return promise;
}
