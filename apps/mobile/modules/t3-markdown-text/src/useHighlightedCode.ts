import { useEffect, useMemo, useRef, useState } from "react";

import { pendingCodeHighlight } from "./pendingCodeHighlight";
import type {
  MarkdownCodeHighlighter,
  MarkdownHighlightedToken,
} from "./SelectableMarkdownText.types";

export type HighlightedCode = ReadonlyArray<ReadonlyArray<MarkdownHighlightedToken>>;

interface HighlightedCodeResult {
  readonly key: string;
  readonly code: string;
  readonly language: string | undefined;
  readonly theme: "light" | "dark";
  readonly tokens: HighlightedCode | null;
}

const highlightedCodeCache = new Map<string, HighlightedCode>();
const highlightedCodePromiseCache = new Map<string, Promise<HighlightedCode>>();
const HIGHLIGHTED_CODE_CACHE_LIMIT = 64;

function codeHighlightCacheKey(
  code: string,
  language: string | undefined,
  theme: "light" | "dark",
): string {
  return `${theme}:${language ?? "text"}:${code}`;
}

function cacheHighlightedCode(key: string, tokens: HighlightedCode): void {
  highlightedCodeCache.delete(key);
  highlightedCodeCache.set(key, tokens);

  while (highlightedCodeCache.size > HIGHLIGHTED_CODE_CACHE_LIMIT) {
    const oldestKey = highlightedCodeCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    highlightedCodeCache.delete(oldestKey);
  }
}

function loadHighlightedCode(
  code: string,
  language: string | undefined,
  theme: "light" | "dark",
  highlightCode: MarkdownCodeHighlighter,
  session: object,
): Promise<HighlightedCode> {
  const key = codeHighlightCacheKey(code, language, theme);
  const cached = highlightedCodeCache.get(key);
  if (cached) {
    return Promise.resolve(cached);
  }

  const pending = highlightedCodePromiseCache.get(key);
  if (pending) {
    return pending;
  }

  const promise = highlightCode({ code, language, theme, session })
    .then((tokens) => {
      cacheHighlightedCode(key, tokens);
      highlightedCodePromiseCache.delete(key);
      return tokens;
    })
    .catch((error) => {
      highlightedCodePromiseCache.delete(key);
      throw error;
    });
  highlightedCodePromiseCache.set(key, promise);
  return promise;
}

/**
 * Tokens for a code block, or null while nothing usable exists yet. A cached or
 * synchronous result renders in the same pass. Otherwise the most recent
 * completed result seeds `pendingCodeHighlight` so finished lines keep their
 * colors while the asynchronous highlighter catches up.
 */
export function useHighlightedCode(
  code: string,
  language: string | undefined,
  theme: "light" | "dark",
  highlightCode: MarkdownCodeHighlighter,
): HighlightedCode | null {
  const [session] = useState(() => ({}));
  const key = codeHighlightCacheKey(code, language, theme);
  const ready = useMemo(
    () => highlightedCodeCache.get(key) ?? highlightCode.read?.({ code, language, theme, session }),
    [code, language, theme, key, highlightCode, session],
  );
  const [highlighted, setHighlighted] = useState<HighlightedCodeResult>(() => ({
    code,
    language,
    theme,
    key,
    tokens: highlightedCodeCache.get(key) ?? null,
  }));
  // Synchronous reads never touch state, so each append costs one render. The
  // ref remembers the newest of them, and is cleared whenever an asynchronous
  // result commits so `highlighted` is the baseline again from then on.
  const latestRead = useRef<HighlightedCodeResult | null>(null);

  useEffect(() => {
    if (ready) {
      latestRead.current = { code, language, theme, key, tokens: ready };
      return;
    }
    let active = true;
    const commit = (tokens: HighlightedCode | null) => {
      latestRead.current = null;
      setHighlighted({ code, language, theme, key, tokens });
    };
    const cached = highlightedCodeCache.get(key);
    if (cached) {
      cacheHighlightedCode(key, cached);
      commit(cached);
      return () => {
        active = false;
      };
    }

    void loadHighlightedCode(code, language, theme, highlightCode, session)
      .then((tokens) => {
        if (active) {
          commit(tokens);
        }
      })
      .catch(() => {
        if (active) {
          commit(null);
        }
      });
    return () => {
      active = false;
    };
  }, [code, highlightCode, key, language, theme, ready, session]);

  if (ready) return ready;
  // oxlint-disable-next-line react/refs -- Written only after commit; a discarded render never advances it.
  const baseline = latestRead.current ?? highlighted;
  if (baseline.key === key) return baseline.tokens;
  if (baseline.tokens && baseline.language === language && baseline.theme === theme) {
    return pendingCodeHighlight(baseline.code, code, baseline.tokens);
  }
  return null;
}
