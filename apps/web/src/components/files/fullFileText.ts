import { useAtomValue } from "@effect/atom-react";
import { splitMarkdown, type SplitMarkdown } from "@t3tools/shared/markdownChunks";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "~/connection/runtime";

import { FULL_TEXT_MAX_BYTES, RENDERED_MAX_LINES } from "./largeTextProtocol";

// A slow download swaps in what has arrived this often, so the reader is not left at 1 MB.
const SWAP_INTERVAL = "1 second";
// Switching back to a recently closed file reuses its text instead of downloading it again.
const RECENT_FILE_TTL_MS = 60_000;

interface Downloaded {
  readonly text: string;
  readonly lines: number;
}

function countNewlines(text: string): number {
  let lines = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    lines += 1;
  }
  return lines;
}

// Past either cap the main thread cannot hold or lay the text out.
const tooLarge = (file: Downloaded) =>
  file.lines > RENDERED_MAX_LINES || file.text.length > FULL_TEXT_MAX_BYTES;

/** A file's text so far, at most once per interval, ending at its whole text or past a cap. */
export const downloadText = (src: string) =>
  HttpClient.get(src).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.map((response) => response.stream),
    Effect.provideService(FetchHttpClient.RequestInit, { cache: "no-store" }),
    Stream.unwrap,
    // Drops a leading BOM, as the 1 MB preview read does.
    Stream.decodeText,
    Stream.scan(
      (): Downloaded => ({ text: "", lines: 1 }),
      (file, chunk) => ({ text: file.text + chunk, lines: file.lines + countNewlines(chunk) }),
    ),
    Stream.takeUntil(tooLarge),
    Stream.groupedWithin(Number.MAX_SAFE_INTEGER, SWAP_INTERVAL),
    Stream.map((swaps) => swaps[swaps.length - 1]!),
  );

/** `src` is the asset URL with its revision, so a changed file downloads again. */
const fullFileTextAtom = Atom.family((src: string) =>
  connectionAtomRuntime
    .atom(downloadText(src))
    .pipe(Atom.setIdleTTL(RECENT_FILE_TTL_MS), Atom.withLabel(`full-file-text:${src}`)),
);

export type FullFileText =
  | { readonly text: string; readonly done: boolean }
  | "too-large"
  | "failed";

/** A file past the 1 MB read: the preview at once, then the full file as it downloads. */
export function useFullFileText(src: string, preview: string): FullFileText {
  const result = useAtomValue(fullFileTextAtom(src));
  if (AsyncResult.isFailure(result)) return "failed";
  if (!AsyncResult.isSuccess(result)) return { text: preview, done: false };
  if (tooLarge(result.value)) return "too-large";
  if (!result.waiting) return { text: result.value.text, done: true };
  // Whole lines only, so the last row does not flicker as it fills in; the first swap can still
  // hold less than the preview already shows.
  const text = result.value.text.slice(0, result.value.text.lastIndexOf("\n") + 1);
  return { text: text.length >= preview.length ? text : preview, done: false };
}

/** The finished text's Markdown pieces, kept as long as its text; splitting 12 MB takes 0.5 s. */
const fullFileMarkdownAtom = Atom.family((src: string) =>
  Atom.make((get) => {
    const result = get(fullFileTextAtom(src));
    return AsyncResult.isSuccess(result) && !result.waiting && !tooLarge(result.value)
      ? splitMarkdown(result.value.text)
      : null;
  }).pipe(Atom.setIdleTTL(RECENT_FILE_TTL_MS), Atom.withLabel(`full-file-markdown:${src}`)),
);

/** Markdown pieces of the text so far; a finished file's are split once and kept. */
export function useFullFileMarkdown(src: string, text: string): SplitMarkdown {
  return useAtomValue(fullFileMarkdownAtom(src)) ?? splitMarkdown(text);
}
