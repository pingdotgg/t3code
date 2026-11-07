import { useMemo } from "react";

import { resolveHighlightLanguage } from "../../lib/highlightLanguage";
import { highlightCode, type HighlightedLines, type HighlightScheme } from "../../lib/highlights";

/** Survives LegendList recycle so settled code does not re-tokenize on remount. */
const HIGHLIGHT_CACHE_LIMIT = 64;
const highlightCache = new Map<string, HighlightedLines>();

function cachedHighlight(code: string, language: string, theme: HighlightScheme): HighlightedLines {
  const key = `${theme}\0${language}\0${code}`;
  const hit = highlightCache.get(key);
  if (hit) {
    highlightCache.delete(key);
    highlightCache.set(key, hit);
    return hit;
  }
  const next = highlightCode(code, resolveHighlightLanguage({ language }), theme);
  highlightCache.set(key, next);
  if (highlightCache.size > HIGHLIGHT_CACHE_LIMIT) {
    const oldest = highlightCache.keys().next().value;
    if (oldest !== undefined) highlightCache.delete(oldest);
  }
  return next;
}

export function useMarkdownCodeHighlight(input: {
  readonly code: string;
  readonly enabled: boolean;
  readonly language: string | null | undefined;
  readonly theme: HighlightScheme;
  /**
   * When false, skip the module cache — streamed prefixes would only fill it with
   * short-lived keys. Settled code (default) is cached across list remounts.
   */
  readonly cache?: boolean;
}): HighlightedLines | null {
  const { code, enabled, theme } = input;
  const language = input.language?.trim();
  const cache = input.cache !== false;
  return useMemo(() => {
    if (!enabled || !language) return null;
    if (!cache) return highlightCode(code, resolveHighlightLanguage({ language }), theme);
    return cachedHighlight(code, language, theme);
  }, [cache, code, enabled, language, theme]);
}
