import { useEffect, useState } from "react";

// Whole-file reads past this stay on the 1 MB RPC preview; a phone lays out every source row.
export const MOBILE_FULL_FILE_MAX_BYTES = 8 * 1024 * 1024;

/** Downloads a file's full text from its asset URL; null while loading or without a URL. */
export function useFullFileText(uri: string | null): {
  readonly text: string | null;
  readonly failed: boolean;
} {
  const [result, setResult] = useState<{
    readonly uri: string;
    readonly text: string | null;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the full-file download and cancels it when the URL changes or the screen closes.
  useEffect(() => {
    if (uri === null) return;
    const controller = new AbortController();
    fetch(uri, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      })
      .then((text) => setResult({ uri, text }))
      .catch(() => {
        if (!controller.signal.aborted) setResult({ uri, text: null });
      });
    return () => controller.abort();
  }, [uri]);
  const settled = uri !== null && result?.uri === uri ? result : null;
  return { text: settled?.text ?? null, failed: settled !== null && settled.text === null };
}
