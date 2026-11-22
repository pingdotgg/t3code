import { useEffect, useState } from "react";

import { FULL_TEXT_MAX_BYTES, RENDERED_MAX_LINES } from "./largeTextProtocol";

// A slow download swaps in what has arrived this often, so the reader is not left at 1 MB.
const SWAP_INTERVAL_MS = 1000;

function countNewlines(text: string): number {
  let lines = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    lines += 1;
  }
  return lines;
}

/**
 * Streams the rest of the file after the bytes already read, handing over the text so far at
 * most once per interval. Resolves the whole text, or "too-large" past the line cap.
 */
export async function downloadRest(input: {
  readonly src: string;
  readonly preview: string;
  readonly sizeBytes: number;
  readonly signal: AbortSignal;
  readonly onProgress: (text: string) => void;
}): Promise<string | "too-large"> {
  // The server decodes the first megabyte strictly and drops a character the cut split, so the
  // preview's UTF-8 length is exactly where the rest begins.
  const offset = new TextEncoder().encode(input.preview).length;
  let response = await fetch(input.src, {
    cache: "no-store",
    signal: input.signal,
    headers: { Range: `bytes=${offset}-` },
  });
  let text = input.preview;
  const total = Number(response.headers.get("content-range")?.split("/")[1]);
  if (response.status !== 206 || total !== input.sizeBytes) {
    // No range support, or the file changed since the preview was read: start over.
    await response.body?.cancel();
    response = await fetch(input.src, { cache: "no-store", signal: input.signal });
    text = "";
  }
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  // A file that grew since the preview was read must still stay within the main-thread ceiling.
  let bytes = text === "" ? 0 : offset;
  const reader = response.body
    .pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
      }),
    )
    .pipeThrough(new TextDecoderStream())
    .getReader();
  let lines = countNewlines(text) + 1;
  let lastSwap = performance.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += value;
    lines += countNewlines(value);
    if (lines > RENDERED_MAX_LINES || bytes > FULL_TEXT_MAX_BYTES) {
      await reader.cancel();
      return "too-large";
    }
    if (performance.now() - lastSwap > SWAP_INTERVAL_MS) {
      lastSwap = performance.now();
      // Hand over whole lines only, so the last row does not flicker as it fills in.
      input.onProgress(text.slice(0, text.lastIndexOf("\n") + 1));
    }
  }
}

export type FullFileText =
  | { readonly text: string; readonly done: boolean }
  | "too-large"
  | "failed";

// Switching back to a recently opened file reuses its text instead of downloading it again.
const RECENT_FILES = 4;
const RECENT_FILE_MAX_CHARS = 16 * 1024 * 1024;
const recentFiles = new Map<string, string>();

function rememberFile(src: string, text: string) {
  if (text.length > RECENT_FILE_MAX_CHARS) return;
  recentFiles.delete(src);
  recentFiles.set(src, text);
  if (recentFiles.size > RECENT_FILES) recentFiles.delete(recentFiles.keys().next().value!);
}

/**
 * The whole text of a file past the 1 MB read: the preview at once, then the full file as it
 * downloads. A new `src` (the asset URL with its revision) downloads again.
 */
export function useFullFileText(input: {
  readonly src: string;
  readonly preview: string;
  readonly sizeBytes: number;
}): FullFileText {
  const [state, setState] = useState<{ readonly src: string; readonly file: FullFileText } | null>(
    () => {
      const cached = recentFiles.get(input.src);
      return cached === undefined ? null : { src: input.src, file: { text: cached, done: true } };
    },
  );
  const { src, preview, sizeBytes } = input;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns the full-file download and cancels it when the source changes or the preview closes.
  useEffect(() => {
    if (recentFiles.has(src)) return;
    const controller = new AbortController();
    downloadRest({
      src,
      preview,
      sizeBytes,
      signal: controller.signal,
      onProgress: (text) => setState({ src, file: { text, done: false } }),
    })
      .then((result) => {
        if (result !== "too-large") rememberFile(src, result);
        setState({ src, file: result === "too-large" ? result : { text: result, done: true } });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ src, file: "failed" });
      });
    return () => controller.abort();
  }, [src, preview, sizeBytes]);
  const cached = state?.src === src ? undefined : recentFiles.get(src);
  if (cached !== undefined) return { text: cached, done: true };
  return state?.src === src ? state.file : { text: preview, done: false };
}
