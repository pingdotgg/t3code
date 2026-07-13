/**
 * Bounded capture of child-process stderr as UTF-8 lines.
 *
 * Keeps a strictly bounded ring of recent lines (by line count and UTF-8 byte
 * budget) so long-running agents cannot grow memory unboundedly, while still
 * preserving a useful diagnostic tail for exit/error surfaces.
 *
 * @module processStderrCapture
 */
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export const DEFAULT_PROCESS_STDERR_MAX_LINES = 200;
export const DEFAULT_PROCESS_STDERR_MAX_BYTES = 64 * 1024;
/** Cap on the incomplete line remainder buffer (UTF-16 code units). */
export const DEFAULT_PROCESS_STDERR_REMAINDER_MAX_BYTES = DEFAULT_PROCESS_STDERR_MAX_BYTES;
export const DEFAULT_LINE_REMAINDER_MAX_CHARS = 1024 * 1024;

export interface BoundedLineSplitResult {
  readonly lines: ReadonlyArray<string>;
  readonly remainder: string;
  readonly truncated: boolean;
}

/** Split complete lines while strictly bounding an incomplete line remainder. */
export function splitLinesWithBoundedRemainder(
  currentRemainder: string,
  chunk: string,
  maxChars: number = DEFAULT_LINE_REMAINDER_MAX_CHARS,
): BoundedLineSplitResult {
  let combined = currentRemainder + chunk;
  let truncated = false;
  if (combined.length > maxChars) {
    combined = combined.slice(combined.length - maxChars);
    truncated = true;
  }
  const parts = combined.split("\n");
  const remainder = parts.pop() ?? "";
  return {
    lines: parts.map((line) => line.replace(/\r$/, "")),
    remainder,
    truncated,
  };
}

export interface ProcessStderrCaptureOptions {
  readonly maxLines?: number;
  readonly maxBytes?: number;
  /** Max UTF-16 code units retained for an incomplete trailing line. Default 1 MiB. */
  readonly maxRemainderChars?: number;
}

export interface ProcessStderrCapture {
  /**
   * Append decoded UTF-8 text. Completes lines on `\n` (optional trailing `\r`
   * is stripped). Returns newly completed lines in arrival order.
   */
  readonly pushText: (text: string) => ReadonlyArray<string>;
  /**
   * Append a binary chunk decoded as UTF-8 with stream-safe multi-byte handling.
   * Returns newly completed lines in arrival order.
   */
  readonly pushChunk: (chunk: Uint8Array) => ReadonlyArray<string>;
  /**
   * Flush any incomplete remainder (and decoder tail) as a final line when
   * non-empty. Returns that line when one was produced.
   */
  readonly flush: () => string | undefined;
  /** Captured lines joined with `\n` (no trailing newline unless an empty line was stored). */
  readonly getTail: () => string;
  readonly getLines: () => ReadonlyArray<string>;
  /** True after the incomplete-line remainder was truncated at least once. */
  readonly didTruncateRemainder: () => boolean;
  /** Consume the remainder-truncation flag so callers log it at most once. */
  readonly takeRemainderTruncated: () => boolean;
}

export interface RunProcessStderrCaptureOptions {
  readonly capture?: ProcessStderrCapture;
  /** Effect logger message label; defaults to `"child process stderr"`. */
  readonly logLabel?: string;
  /** Annotations attached to each debug log (provider, pid, command, …). */
  readonly annotations?: Record<string, unknown>;
  /** Optional per-line side effect (e.g. NDJSON logging, classification). */
  readonly onLine?: (line: string) => Effect.Effect<void>;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Create a bounded ring buffer for stderr lines.
 *
 * When either `maxLines` or `maxBytes` would be exceeded, the oldest lines are
 * dropped until both budgets are satisfied. The incomplete-line remainder is
 * also capped so a single huge line without newlines cannot grow unboundedly.
 */
export function makeProcessStderrCapture(
  options: ProcessStderrCaptureOptions = {},
): ProcessStderrCapture {
  const maxLines = Math.max(1, options.maxLines ?? DEFAULT_PROCESS_STDERR_MAX_LINES);
  const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_PROCESS_STDERR_MAX_BYTES);
  const maxRemainderChars = Math.max(
    1,
    options.maxRemainderChars ?? DEFAULT_PROCESS_STDERR_REMAINDER_MAX_BYTES,
  );

  const lines: string[] = [];
  let totalBytes = 0;
  let remainder = "";
  let remainderTruncated = false;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const trimToBudget = (): void => {
    while (lines.length > maxLines || (totalBytes > maxBytes && lines.length > 0)) {
      const removed = lines.shift();
      if (removed === undefined) {
        break;
      }
      totalBytes -= utf8ByteLength(removed);
      if (lines.length > 0) {
        // Account for the `\n` separator that joined the removed line to the next.
        totalBytes -= 1;
      }
    }
    if (totalBytes < 0) {
      totalBytes = 0;
    }
  };

  const pushCompletedLine = (line: string): void => {
    if (lines.length > 0) {
      totalBytes += 1; // `\n` between lines in getTail()
    }
    lines.push(line);
    totalBytes += utf8ByteLength(line);
    trimToBudget();
  };

  const capRemainder = (value: string): string => {
    if (value.length <= maxRemainderChars) {
      return value;
    }
    remainderTruncated = true;
    return value.slice(value.length - maxRemainderChars);
  };

  const pushText = (text: string): ReadonlyArray<string> => {
    if (text.length === 0) {
      return [];
    }
    const combined = capRemainder(remainder + text);
    const parts = combined.split("\n");
    remainder = capRemainder(parts.pop() ?? "");
    const completed: string[] = [];
    for (const part of parts) {
      const line = part.replace(/\r$/, "");
      pushCompletedLine(line);
      completed.push(line);
    }
    return completed;
  };

  const pushChunk = (chunk: Uint8Array): ReadonlyArray<string> => {
    if (chunk.byteLength === 0) {
      return [];
    }
    return pushText(decoder.decode(chunk, { stream: true }));
  };

  const flush = (): string | undefined => {
    const decoderTail = decoder.decode();
    if (decoderTail.length > 0) {
      remainder = capRemainder(remainder + decoderTail);
    }
    if (remainder.length === 0) {
      return undefined;
    }
    const line = remainder.replace(/\r$/, "");
    remainder = "";
    pushCompletedLine(line);
    return line;
  };

  const getTail = (): string => {
    // Include any incomplete remainder so callers can inspect mid-line output
    // before the stream flushes (e.g. process crash without a trailing newline).
    const pending = remainder.replace(/\r$/, "");
    const tail =
      lines.length === 0
        ? pending
        : pending.length === 0
          ? lines.join("\n")
          : `${lines.join("\n")}\n${pending}`;
    const bytes = encoder.encode(tail);
    if (bytes.byteLength <= maxBytes) {
      return tail;
    }
    let start = bytes.byteLength - maxBytes;
    // Do not start inside a UTF-8 continuation byte.
    while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) {
      start += 1;
    }
    return new TextDecoder().decode(bytes.subarray(start));
  };

  return {
    pushText,
    pushChunk,
    flush,
    getTail,
    getLines: () => lines.slice(),
    didTruncateRemainder: () => remainderTruncated,
    takeRemainderTruncated: () => {
      if (!remainderTruncated) {
        return false;
      }
      remainderTruncated = false;
      return true;
    },
  };
}

const handleCapturedLines = (
  lines: ReadonlyArray<string>,
  options: {
    readonly logLabel: string;
    readonly annotations: Record<string, unknown>;
    readonly onLine?: (line: string) => Effect.Effect<void>;
    readonly capture: ProcessStderrCapture;
  },
) =>
  Effect.gen(function* () {
    if (options.capture.takeRemainderTruncated()) {
      yield* Effect.logWarning("child process stderr line remainder truncated").pipe(
        Effect.annotateLogs(options.annotations),
      );
    }
    yield* Effect.forEach(
      lines,
      (line) =>
        Effect.logDebug(options.logLabel).pipe(
          Effect.annotateLogs({ ...options.annotations, line }),
          Effect.andThen(options.onLine ? options.onLine(line) : Effect.void),
        ),
      { discard: true },
    );
  });

/**
 * Drain `stream` into a bounded stderr capture, logging each completed line at
 * debug level. Stream failures are ignored so a broken stderr pipe cannot take
 * down the protocol client. The capture is always flushed when the stream ends.
 */
export const drainProcessStderrCapture = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  options: RunProcessStderrCaptureOptions = {},
): Effect.Effect<ProcessStderrCapture> =>
  Effect.gen(function* () {
    const capture = options.capture ?? makeProcessStderrCapture();
    const logLabel = options.logLabel ?? "child process stderr";
    const annotations = options.annotations ?? {};
    const lineOptions = {
      logLabel,
      annotations,
      capture,
      ...(options.onLine ? { onLine: options.onLine } : {}),
    };

    yield* stream.pipe(
      Stream.runForEach((chunk) => handleCapturedLines(capture.pushChunk(chunk), lineOptions)),
      Effect.ensuring(
        Effect.suspend(() => {
          const finalLine = capture.flush();
          return finalLine === undefined
            ? Effect.void
            : handleCapturedLines([finalLine], lineOptions);
        }),
      ),
      Effect.ignore,
    );

    return capture;
  });

/**
 * Fork a scoped fiber that drains `stream` into a bounded stderr capture.
 * Returns the live capture immediately so callers can read `getTail()` after
 * process exit without waiting for the drain fiber.
 */
export const runProcessStderrCapture = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  options: RunProcessStderrCaptureOptions = {},
): Effect.Effect<ProcessStderrCapture, never, Scope.Scope> =>
  Effect.gen(function* () {
    const capture = options.capture ?? makeProcessStderrCapture();
    yield* drainProcessStderrCapture(stream, { ...options, capture }).pipe(Effect.forkScoped);
    return capture;
  });
