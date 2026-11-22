import { RENDERED_MAX_LINES } from "./largeTextProtocol";

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
 * most once per interval. Resolves the whole text, or "too-tall" past the line cap.
 */
export async function downloadRest(input: {
  readonly src: string;
  readonly preview: string;
  readonly sizeBytes: number;
  readonly signal: AbortSignal;
  readonly onProgress: (text: string) => void;
}): Promise<string | "too-tall"> {
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
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let lines = countNewlines(text) + 1;
  let lastSwap = performance.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += value;
    lines += countNewlines(value);
    if (lines > RENDERED_MAX_LINES) {
      await reader.cancel();
      return "too-tall";
    }
    if (performance.now() - lastSwap > SWAP_INTERVAL_MS) {
      lastSwap = performance.now();
      // Hand over whole lines only, so the last row does not flicker as it fills in.
      input.onProgress(text.slice(0, text.lastIndexOf("\n") + 1));
    }
  }
}
