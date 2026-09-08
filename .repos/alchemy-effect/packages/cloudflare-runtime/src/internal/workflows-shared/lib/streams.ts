// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import {
  InvalidStepReadableStreamError,
  OversizedStreamChunkError,
  StreamOutputStorageLimitError,
  UnsupportedStreamChunkError,
  WorkflowTimeoutError,
} from "./errors.ts";

// ── Constants ───────────────────────────────────────────────────────────────

export const DEFAULT_STREAM_OUTPUT_CHUNK_SIZE = 256 * 1024;
export const STREAM_OUTPUT_META_SUFFIX = "-value-stream-meta";
export const MAX_STREAM_OUTPUT_INPUT_CHUNK_BYTES = 16 * 1024 * 1024;
export const STREAMING_STEP_CHUNKS_TABLE = "streaming_step_chunks";
export const MAX_OUTPUT_SHOWN_IN_LOGS = 1024;

const DO_STORAGE_LIMIT = 1024 * 1024 * 1024 + 100 * 1024 * 1024;
const STREAM_OUTPUT_STORAGE_WRITE_HEADROOM_BYTES = 16 * 1024;

// ── Types ───────────────────────────────────────────────────────────────────

export enum StreamOutputState {
  Pending = "pending",
  Committing = "committing",
  Complete = "complete",
}

export type StreamOutputMeta = {
  version: 1;
  state: StreamOutputState;
  attempt: number;
  startedAt: number;
  chunkCount: number;
  totalBytes: number;
  committedAt: number | null;
};

export type StoredStreamOutputPreview = { type: "text"; output: string } | { type: "binary" };

export class InvalidStoredStreamOutputError extends Error {
  name = "InvalidStoredStreamOutputError";
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function getStreamOutputMetaKey(cacheKey: string): string {
  return `${cacheKey}${STREAM_OUTPUT_META_SUFFIX}`;
}

export function isReadableStreamLike(value: unknown): value is ReadableStream<unknown> {
  return value instanceof ReadableStream;
}

function createInvalidStepReadableStreamError(): InvalidStepReadableStreamError {
  return new InvalidStepReadableStreamError(
    "Step returned a ReadableStream that is already locked or otherwise unreadable. Return a fresh, unlocked ReadableStream from step.do().",
  );
}

function createOversizedStreamChunkError(): OversizedStreamChunkError {
  return new OversizedStreamChunkError(
    `Step returned a ReadableStream chunk larger than the maximum allowed size of ${MAX_STREAM_OUTPUT_INPUT_CHUNK_BYTES} bytes. ` +
      "Return smaller chunks from step.do().",
  );
}

/**
 * Normalize any incoming chunk to Uint8Array.
 * Accepts ArrayBuffer, TypedArrays (except DataView), and Uint8Array directly.
 * Rejects strings, objects, and other non-binary types.
 */
function normalizeChunkToUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  throw new UnsupportedStreamChunkError(
    "Step returned a ReadableStream with unsupported chunk type. " +
      "Only ArrayBuffer and TypedArray chunks are supported.",
  );
}

// ── Buffer helpers ──────────────────────────────────────────────────────────

function takeBufferedBytes(bufferedChunks: Array<Uint8Array>, byteLength: number): Uint8Array {
  const output = new Uint8Array(byteLength);
  let offset = 0;

  while (offset < byteLength) {
    const chunk = bufferedChunks[0];
    const remaining = byteLength - offset;

    if (chunk.byteLength <= remaining) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
      bufferedChunks.shift();
      continue;
    }

    output.set(chunk.subarray(0, remaining), offset);
    bufferedChunks[0] = chunk.subarray(remaining);
    offset += remaining;
  }

  return output;
}

// ── Stream iteration ────────────────────────────────────────────────────────

async function* iterateStreamChunks(
  stream: ReadableStream<unknown>,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  if (stream.locked) {
    throw createInvalidStepReadableStreamError();
  }

  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  }

  let reader: ReadableStreamDefaultReader<unknown>;
  try {
    reader = stream.getReader();
  } catch (error) {
    if (error instanceof TypeError) {
      throw createInvalidStepReadableStreamError();
    }
    throw error;
  }

  const onAbort = () => {
    void reader
      .cancel(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"))
      .catch(() => {});
  };

  signal?.addEventListener("abort", onAbort, { once: true });
  let fullyRead = false;

  try {
    while (true) {
      let readResult: ReadableStreamReadResult<unknown>;
      try {
        readResult = await reader.read();
      } catch (readError) {
        // When the abort signal has already fired, the read error is an
        // expected cancellation (e.g. step timeout or engine shutdown).
        // Re-throw the original abort reason so callers can distinguish
        // timeouts from genuine stream failures.
        if (signal?.aborted) {
          throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
        }

        // Any other read failure (broken pipe, upstream connection
        // drop, encoding mismatch, etc.) means the ReadableStream the
        // step returned is unusable.
        throw new InvalidStepReadableStreamError(
          "Failed to read from step ReadableStream output. " +
            (readError instanceof Error ? readError.message : String(readError)),
        );
      }

      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
      }
      if (readResult.done) {
        fullyRead = true;
        return;
      }

      yield normalizeChunkToUint8Array(readResult.value);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!fullyRead) {
      await reader
        .cancel(new Error("stream output consumption stopped before completion"))
        .catch(() => {});
    }
    try {
      reader.releaseLock();
    } catch {
      // Reader may still be processing cancel()
    }
  }
}

// ── SQL helpers ─────────────────────────────────────────────────────────────

function deleteAttemptChunks(
  storage: DurableObjectStorage,
  cacheKey: string,
  attempt: number,
): void {
  // eslint-disable-next-line workers-sdk/no-unsafe-command-execution -- DO SQL exec, not child_process
  storage.sql.exec(
    `DELETE FROM ${STREAMING_STEP_CHUNKS_TABLE} WHERE cache_key = ? AND attempt = ?`,
    cacheKey,
    attempt,
  );
}

async function deleteMetaForAttempt(
  storage: DurableObjectStorage,
  cacheKey: string,
  attempt: number,
): Promise<void> {
  const metaKey = getStreamOutputMetaKey(cacheKey);
  const maybeMeta = await storage.get<StreamOutputMeta>(metaKey);
  if (maybeMeta === undefined) {
    return;
  }
  if (maybeMeta.attempt !== attempt) {
    return;
  }
  await storage.delete(metaKey);
}

// ── Integrity validation ────────────────────────────────────────────────────

type StreamOutputChunkSummary = {
  chunkCount: number;
  minChunkIndex: number | null;
  maxChunkIndex: number | null;
  totalBytes: number;
};

function getStreamOutputChunkSummary(
  storage: DurableObjectStorage,
  cacheKey: string,
  attempt: number,
): StreamOutputChunkSummary {
  const row = storage.sql
    .exec<StreamOutputChunkSummary>(
      [
        `SELECT`,
        `  COUNT(*) AS chunkCount,`,
        `  MIN(chunk_index) AS minChunkIndex,`,
        `  MAX(chunk_index) AS maxChunkIndex,`,
        `  CAST(COALESCE(SUM(LENGTH(chunk)), 0) AS INTEGER) AS totalBytes`,
        `FROM ${STREAMING_STEP_CHUNKS_TABLE}`,
        `WHERE cache_key = ? AND attempt = ?`,
      ].join("\n"),
      cacheKey,
      attempt,
    )
    .one();

  if (row === null) {
    throw new Error("Expected stream chunk summary query to return a row");
  }
  return row;
}

export function getInvalidStoredStreamOutputError(
  storage: DurableObjectStorage,
  cacheKey: string,
  meta: StreamOutputMeta,
): InvalidStoredStreamOutputError | undefined {
  const summary = getStreamOutputChunkSummary(storage, cacheKey, meta.attempt);

  if (meta.chunkCount === 0) {
    if (
      summary.chunkCount === 0 &&
      summary.totalBytes === 0 &&
      summary.minChunkIndex === null &&
      summary.maxChunkIndex === null
    ) {
      return undefined;
    }
  } else if (
    summary.chunkCount === meta.chunkCount &&
    summary.minChunkIndex === 0 &&
    summary.maxChunkIndex === meta.chunkCount - 1 &&
    summary.totalBytes === meta.totalBytes
  ) {
    return undefined;
  }

  return new InvalidStoredStreamOutputError(
    `Stored streamed step output is corrupt or incomplete for cache key ${cacheKey}. ` +
      `Expected ${meta.chunkCount} chunks / ${meta.totalBytes} bytes, found ` +
      `${summary.chunkCount} chunks / ${summary.totalBytes} bytes with chunk index range ` +
      `${summary.minChunkIndex ?? "null"}..${summary.maxChunkIndex ?? "null"}.`,
  );
}

// ── Preview ─────────────────────────────────────────────────────────────────

function readStreamOutputPreviewBytes(options: {
  storage: DurableObjectStorage;
  cacheKey: string;
  attempt: number;
  maxBytes: number;
}): Uint8Array {
  const { storage, cacheKey, attempt, maxBytes } = options;
  // eslint-disable-next-line workers-sdk/no-unsafe-command-execution -- DO SQL exec, not child_process
  const cursor = storage.sql.exec<{
    chunk_index: number;
    chunk: ArrayBuffer;
  }>(
    `SELECT chunk_index, chunk FROM ${STREAMING_STEP_CHUNKS_TABLE} WHERE cache_key = ? AND attempt = ? ORDER BY chunk_index`,
    cacheKey,
    attempt,
  );
  const previewChunks: Array<Uint8Array> = [];
  let expectedChunkIndex = 0;
  let totalBytes = 0;

  while (totalBytes < maxBytes) {
    const row = cursor.next();
    if (row.done) {
      break;
    }

    if (row.value.chunk_index !== expectedChunkIndex) {
      throw new InvalidStoredStreamOutputError(
        `Missing chunk ${expectedChunkIndex} for streamed step output`,
      );
    }

    if (!(row.value.chunk instanceof ArrayBuffer)) {
      throw new InvalidStoredStreamOutputError(
        "Invalid chunk type returned from streaming_step_chunks table",
      );
    }

    const chunkBytes = new Uint8Array(row.value.chunk);
    const remainingBytes = maxBytes - totalBytes;
    const previewChunk =
      chunkBytes.byteLength > remainingBytes ? chunkBytes.subarray(0, remainingBytes) : chunkBytes;

    previewChunks.push(previewChunk);
    totalBytes += previewChunk.byteLength;
    expectedChunkIndex++;
  }

  return takeBufferedBytes(previewChunks, totalBytes);
}

export function getStoredStreamOutputPreview(options: {
  storage: DurableObjectStorage;
  cacheKey: string;
  meta: StreamOutputMeta;
  maxChars: number;
}): StoredStreamOutputPreview {
  const { storage, cacheKey, meta, maxChars } = options;
  if (meta.state !== StreamOutputState.Complete) {
    throw new Error("Cannot preview streamed step output before it is complete");
  }

  // UTF-8 uses at most 4 bytes per code point
  const maxPreviewBytes = maxChars * 4;
  const previewBytes = readStreamOutputPreviewBytes({
    storage,
    cacheKey,
    attempt: meta.attempt,
    maxBytes: maxPreviewBytes,
  });
  const previewTruncatedByBytes = meta.totalBytes > previewBytes.byteLength;

  try {
    const decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(previewBytes, { stream: previewTruncatedByBytes });

    const previewOutput = decoded.substring(0, maxChars);
    if (decoded.length > maxChars || previewTruncatedByBytes) {
      return { type: "text", output: previewOutput + "[truncated output]" };
    }
    return { type: "text", output: previewOutput };
  } catch {
    return { type: "binary" };
  }
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

export async function cleanupPendingStreamOutput(
  storage: DurableObjectStorage,
  cacheKey: string,
): Promise<void> {
  const metaKey = getStreamOutputMetaKey(cacheKey);
  const maybeMeta = await storage.get<StreamOutputMeta>(metaKey);

  if (maybeMeta === undefined) {
    return;
  }

  if (maybeMeta.state === StreamOutputState.Complete) {
    return;
  }

  await rollbackStreamOutput(storage, cacheKey, maybeMeta.attempt);
}

export async function rollbackStreamOutput(
  storage: DurableObjectStorage,
  cacheKey: string,
  attempt: number,
): Promise<void> {
  deleteAttemptChunks(storage, cacheKey, attempt);
  await deleteMetaForAttempt(storage, cacheKey, attempt);
}

// ── Write ───────────────────────────────────────────────────────────────────

async function doWriteStreamOutput(options: {
  storage: DurableObjectStorage;
  cacheKey: string;
  attempt: number;
  stream: ReadableStream<unknown>;
  chunkSizeBytes?: number;
  signal?: AbortSignal;
  skipMetaWrite?: boolean;
}): Promise<StreamOutputMeta> {
  const { storage, cacheKey, attempt, stream, signal, skipMetaWrite } = options;
  const chunkSizeBytes = options.chunkSizeBytes ?? DEFAULT_STREAM_OUTPUT_CHUNK_SIZE;
  const metaKey = getStreamOutputMetaKey(cacheKey);

  const maybeInvalidState = (additionalBytes = 0): unknown => {
    if (signal?.aborted) {
      return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
    }

    const currentStorageBytes = storage.sql.databaseSize;
    if (
      currentStorageBytes + additionalBytes + STREAM_OUTPUT_STORAGE_WRITE_HEADROOM_BYTES >
      DO_STORAGE_LIMIT
    ) {
      return new StreamOutputStorageLimitError("The instance has exceeded the 1GiB storage limit");
    }
  };

  const initialInvalidState = maybeInvalidState();
  if (initialInvalidState !== undefined) {
    throw initialInvalidState;
  }

  const startedAt = Date.now();
  if (!skipMetaWrite) {
    await storage.put(metaKey, {
      version: 1,
      state: StreamOutputState.Pending,
      attempt,
      startedAt,
      chunkCount: 0,
      totalBytes: 0,
      committedAt: null,
    } satisfies StreamOutputMeta);
  }

  let chunkCount = 0;
  let totalBytes = 0;
  const bufferedChunks: Array<Uint8Array> = [];
  let bufferedBytes = 0;
  let outputCommitted = false;

  const flushChunk = async (bytes: Uint8Array) => {
    const invalidState = maybeInvalidState(bytes.byteLength);
    if (invalidState !== undefined) {
      throw invalidState;
    }
    // eslint-disable-next-line workers-sdk/no-unsafe-command-execution -- DO SQL exec, not child_process
    storage.sql.exec(
      `INSERT INTO ${STREAMING_STEP_CHUNKS_TABLE} (cache_key, attempt, chunk_index, chunk) VALUES (?, ?, ?, ?)`,
      cacheKey,
      attempt,
      chunkCount,
      bytes,
    );
    totalBytes += bytes.byteLength;
    chunkCount++;
  };

  try {
    for await (const bytes of iterateStreamChunks(stream, signal)) {
      if (bytes.byteLength === 0) {
        continue;
      }

      if (bytes.byteLength > MAX_STREAM_OUTPUT_INPUT_CHUNK_BYTES) {
        throw createOversizedStreamChunkError();
      }

      bufferedChunks.push(bytes);
      bufferedBytes += bytes.byteLength;

      // NOTE: we want chunks with fixed length,
      // that's why we buffer them in-memory here
      while (bufferedBytes >= chunkSizeBytes) {
        const chunk = takeBufferedBytes(bufferedChunks, chunkSizeBytes);
        bufferedBytes -= chunk.byteLength;
        await flushChunk(chunk);
      }
    }

    // Last chunk (remainder)
    if (bufferedBytes > 0) {
      await flushChunk(takeBufferedBytes(bufferedChunks, bufferedBytes));
      bufferedBytes = 0;
    }

    const meta = {
      version: 1,
      state: StreamOutputState.Complete,
      attempt,
      startedAt,
      chunkCount,
      totalBytes,
      committedAt: Date.now(),
    } satisfies StreamOutputMeta;

    const invalidState = maybeInvalidState();
    if (invalidState !== undefined) {
      throw invalidState;
    }

    if (!skipMetaWrite) {
      // Transition to Committing to signal it's safe to await.
      // Mock stream setup still needs the SQL chunks and returned meta, but
      // must not publish the normal stream cache key because Context.do()
      // treats it as a completed prior run and skips step execution logging.
      await storage.put(metaKey, {
        version: 1,
        state: StreamOutputState.Committing,
        attempt,
        startedAt,
        chunkCount,
        totalBytes,
        committedAt: null,
      } satisfies StreamOutputMeta);

      await storage.put(metaKey, meta);
    }
    outputCommitted = true;
    return meta;
  } catch (error) {
    if (!outputCommitted) {
      await rollbackStreamOutput(storage, cacheKey, attempt);
    }
    throw error;
  }
}

export async function writeStreamOutput(options: {
  storage: DurableObjectStorage;
  cacheKey: string;
  attempt: number;
  stream: ReadableStream<unknown>;
  chunkSizeBytes?: number;
  signal?: AbortSignal;
  timeoutTask?: Promise<never>;
  skipMetaWrite?: boolean;
}): Promise<StreamOutputMeta> {
  const { storage, cacheKey, attempt, timeoutTask, ...writeOptions } = options;
  const writeTask = doWriteStreamOutput({
    storage,
    cacheKey,
    attempt,
    ...writeOptions,
  });

  if (timeoutTask === undefined) {
    return writeTask;
  }

  try {
    return await Promise.race([writeTask, timeoutTask]);
  } catch (error) {
    if (error instanceof WorkflowTimeoutError) {
      if (options.skipMetaWrite) {
        void writeTask.catch(() => {});
        throw error;
      }

      const maybeMeta = await storage.get<StreamOutputMeta>(getStreamOutputMetaKey(cacheKey));
      if (
        maybeMeta?.attempt === attempt &&
        (maybeMeta.state === StreamOutputState.Committing ||
          maybeMeta.state === StreamOutputState.Complete)
      ) {
        // Safe to await -- not in the middle of writing chunks
        return await writeTask;
      }

      void writeTask.catch(() => {});
      throw error;
    }

    throw error;
  }
}

// ── Replay ──────────────────────────────────────────────────────────────────

export function createReplayReadableStream(options: {
  storage: DurableObjectStorage;
  cacheKey: string;
  meta: StreamOutputMeta;
}): ReadableStream<Uint8Array> {
  const { storage, cacheKey, meta } = options;
  if (meta.state !== StreamOutputState.Complete) {
    throw new Error("Cannot replay streamed step output before it is complete");
  }

  // eslint-disable-next-line workers-sdk/no-unsafe-command-execution -- DO SQL exec, not child_process
  const chunkCursor = storage.sql.exec<{
    chunk_index: number;
    chunk: ArrayBuffer;
  }>(
    `SELECT chunk_index, chunk FROM ${STREAMING_STEP_CHUNKS_TABLE} WHERE cache_key = ? AND attempt = ? ORDER BY chunk_index`,
    cacheKey,
    meta.attempt,
  );
  let index = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= meta.chunkCount) {
        controller.close();
        return;
      }

      const row = chunkCursor.next();
      if (row.done) {
        controller.error(new Error(`Missing chunk ${index} for streamed step output`));
        return;
      }

      if (row.value.chunk_index !== index) {
        controller.error(new Error(`Missing chunk ${index} for streamed step output`));
        return;
      }

      if (!(row.value.chunk instanceof ArrayBuffer)) {
        controller.error(new Error("Invalid chunk type returned from streaming_step_chunks table"));
        return;
      }

      controller.enqueue(new Uint8Array(row.value.chunk));
      index++;
    },
  });
}
