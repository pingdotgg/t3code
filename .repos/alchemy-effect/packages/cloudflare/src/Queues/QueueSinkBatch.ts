import type { NonEmptyReadonlyArray } from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import type { Queue } from "./Queue.ts";
import { QueueSink, type QueueSinkClient } from "./QueueSink.ts";
import { WriteQueue, type WriteQueueClient } from "./WriteQueue.ts";

/** Cloudflare's `sendBatch` limit on messages per call. */
export const MAX_BATCH_MESSAGES = 100;

/** Cloudflare's `sendBatch` limit on total batch size (1 KB = 1000 bytes). */
export const MAX_BATCH_BYTES = 256_000;

/** Internal metadata Cloudflare counts against the size limits per message. */
export const MESSAGE_OVERHEAD_BYTES = 100;

const encoder = new TextEncoder();

const utf8ByteLength = (value: string): number => {
  // Node-compatible Workers expose Buffer globally. Do not import node:buffer:
  // older Workers and no_nodejs_compat deployments still need the web fallback.
  const buffer = globalThis.Buffer;
  return typeof buffer?.byteLength === "function"
    ? buffer.byteLength(value, "utf8")
    : encoder.encode(value).length;
};

/**
 * Approximate wire size of one message: its UTF-8 JSON encoding plus the
 * per-message metadata overhead. Values JSON cannot encode count as the
 * overhead alone; `sendBatch` rejects them and the error surfaces through
 * the sink.
 */
export const messageSize = (body: unknown): number => {
  let json: string | undefined;
  try {
    json = JSON.stringify(body);
  } catch {
    json = undefined;
  }
  return (json === undefined ? 0 : utf8ByteLength(json)) + MESSAGE_OVERHEAD_BYTES;
};

/**
 * Greedily pack bodies into batches of at most {@link MAX_BATCH_MESSAGES}
 * messages and {@link MAX_BATCH_BYTES} bytes, preserving order. A single
 * message larger than the byte limit ships alone so Cloudflare's rejection
 * surfaces instead of the message being dropped.
 */
export const packQueueSinkBatches = <A>(
  bodies: ReadonlyArray<A>,
): ReadonlyArray<ReadonlyArray<A>> => {
  const batches: A[][] = [];
  let current: A[] = [];
  let currentBytes = 0;
  for (const body of bodies) {
    const size = messageSize(body);
    if (
      current.length >= MAX_BATCH_MESSAGES ||
      (current.length > 0 && currentBytes + size > MAX_BATCH_BYTES)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(body);
    currentBytes += size;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
};

/** Build the sink over a `WriteQueue` client: one `sendBatch` per packed batch. */
export const makeQueueSink = (client: WriteQueueClient): QueueSinkClient =>
  Sink.forEachArray((chunk: NonEmptyReadonlyArray<unknown>) =>
    Effect.forEach(
      packQueueSinkBatches(chunk),
      (batch) => client.sendBatch(batch.map((body) => ({ body }))),
      { discard: true },
    ),
  );

/**
 * {@link QueueSink} over whichever {@link WriteQueue} implementation is
 * provided. Composed with each `WriteQueue` layer in `QueueSinkBinding`,
 * `QueueSinkHttp` and `QueueSinkLocal`.
 */
export const QueueSinkFromWriteQueue = Layer.effect(
  QueueSink,
  Effect.gen(function* () {
    const writeQueue = yield* WriteQueue;
    return Effect.fn(function* (queue: Queue) {
      const client = yield* writeQueue(queue);
      return makeQueueSink(client);
    });
  }),
);
