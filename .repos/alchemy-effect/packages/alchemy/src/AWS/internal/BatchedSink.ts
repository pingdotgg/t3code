import type { NonEmptyReadonlyArray } from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Sink from "effect/Sink";

/**
 * Raised when a batch API keeps reporting entries as unprocessed after the
 * bounded retry schedule is exhausted. Carries the stranded entries (in input
 * order) so callers can decide what to do with them (DLQ, die, drop).
 */
export class BatchRetryExhaustedError<In> extends Data.TaggedError(
  "BatchRetryExhaustedError",
)<{
  /** The entries that were still unprocessed when retries ran out, in input order. */
  readonly entries: readonly In[];
}> {}

export interface BatchedSinkOptions<In, Out, Err> {
  /**
   * API max records per call (10 for SQS `SendMessageBatch` / SNS
   * `PublishBatch`, 25 for `BatchWriteItem`, 500 for Kinesis `PutRecords`,
   * 500 for Firehose, 10 for EventBridge, ...).
   */
  readonly maxRecords: number;
  /** API max payload bytes per call; entries are greedily packed. */
  readonly maxBytes?: number;
  /** Approximate wire size of one record; required for `maxBytes` packing. */
  readonly sizeOf?: (record: In) => number;
  /** One API call per packed batch. Receives entries in input order. */
  readonly send: (batch: readonly In[]) => Effect.Effect<Out, Err>;
  /**
   * Extract entries the API reports as *transiently* unprocessed (returned in
   * input order). These are re-submitted on the bounded `retrySchedule`.
   */
  readonly unprocessed?: (out: Out, batch: readonly In[]) => readonly In[];
  /**
   * Extract entries the API reports as *permanently* rejected (returned in
   * input order). Distinct from `unprocessed`: rejected entries are never
   * retried — they are dropped and surfaced via `onRejected`.
   */
  readonly rejected?: (out: Out, batch: readonly In[]) => readonly In[];
  /**
   * Invoked with permanently-rejected entries before they are dropped.
   * @default logs a warning with the rejected entry count
   */
  readonly onRejected?: (entries: readonly In[]) => Effect.Effect<void>;
  /**
   * Bounded retry for the unprocessed subset.
   * @default Schedule.recurs(5) ∩ Schedule.exponential("200 millis")
   */
  readonly retrySchedule?: Schedule.Schedule<unknown>;
}

/**
 * The shared engine behind every AWS batch-API sink (`SQS.QueueSink`,
 * `SNS.TopicSink`, `Kinesis.StreamSink`, ...).
 *
 * Semantics:
 * - each upstream chunk is split into `<= maxRecords` / `<= maxBytes` batches
 *   **preserving input order**;
 * - batches are sent **sequentially** (order-preservation is the default);
 * - after each `send`, the `rejected` subset is surfaced via `onRejected` and
 *   dropped, and the `unprocessed` subset is re-submitted (in order) on the
 *   bounded `retrySchedule`;
 * - exhausting retries fails the sink with a typed
 *   {@link BatchRetryExhaustedError} carrying the stranded entries.
 *
 * Internal — NOT exported from the `AWS` barrel.
 */
export const makeBatchedSink = <In, Out, Err>(
  options: BatchedSinkOptions<In, Out, Err>,
): Sink.Sink<void, In, never, Err | BatchRetryExhaustedError<In>> => {
  const schedule =
    options.retrySchedule ??
    Schedule.max([Schedule.recurs(5), Schedule.exponential("200 millis")]);

  const onRejected =
    options.onRejected ??
    ((entries: readonly In[]) =>
      Effect.logWarning(
        `BatchedSink dropped ${entries.length} permanently rejected entr${
          entries.length === 1 ? "y" : "ies"
        }`,
      ));

  // One attempt over the currently-pending subset. Returns the entries that
  // are still unprocessed after this attempt (empty = converged).
  const attempt = (
    pendingRef: Ref.Ref<readonly In[]>,
  ): Effect.Effect<readonly In[], Err> =>
    Effect.gen(function* () {
      const pending = yield* Ref.get(pendingRef);
      if (pending.length === 0) {
        return pending;
      }
      const out = yield* options.send(pending);
      const rejected = options.rejected?.(out, pending) ?? [];
      if (rejected.length > 0) {
        yield* onRejected(rejected);
      }
      const remaining = options.unprocessed?.(out, pending) ?? [];
      yield* Ref.set(pendingRef, remaining);
      return remaining;
    });

  const flushBatch = (
    batch: readonly In[],
  ): Effect.Effect<void, Err | BatchRetryExhaustedError<In>> =>
    Effect.gen(function* () {
      const pendingRef = yield* Ref.make(batch);
      yield* repeatWhilePending(attempt(pendingRef), schedule);
      const stranded = yield* Ref.get(pendingRef);
      if (stranded.length > 0) {
        return yield* new BatchRetryExhaustedError({ entries: stranded });
      }
    });

  return Sink.forEachArray((chunk: NonEmptyReadonlyArray<In>) =>
    Effect.gen(function* () {
      const batches = yield* Effect.sync(() => packBatches(chunk, options));
      yield* Effect.forEach(batches, flushBatch, { discard: true });
    }),
  );
};

/**
 * Re-runs `step` (which re-submits the pending subset) on the bounded
 * schedule until it reports nothing left to send.
 *
 * Extracted with an explicit return type so `Repeat.Return`'s conditional
 * type never leaks into declaration emit (see PATTERNS §7 on inlined
 * retry/repeat poisoning `.d.ts` inference).
 */
const repeatWhilePending = <In, Err>(
  step: Effect.Effect<readonly In[], Err>,
  schedule: Schedule.Schedule<unknown>,
): Effect.Effect<readonly In[], Err> =>
  Effect.repeat(step, {
    schedule,
    until: (remaining: readonly In[]) => remaining.length === 0,
  });

/** Greedily pack a chunk into `<= maxRecords` / `<= maxBytes` batches, preserving order. */
const packBatches = <In>(
  chunk: NonEmptyReadonlyArray<In>,
  options: {
    readonly maxRecords: number;
    readonly maxBytes?: number;
    readonly sizeOf?: (record: In) => number;
  },
): readonly (readonly In[])[] => {
  const { maxBytes, maxRecords, sizeOf } = options;
  const batches: In[][] = [];
  let current: In[] = [];
  let currentBytes = 0;
  for (const record of chunk) {
    const size = sizeOf?.(record) ?? 0;
    const overRecords = current.length >= maxRecords;
    const overBytes =
      maxBytes !== undefined &&
      current.length > 0 &&
      currentBytes + size > maxBytes;
    if (overRecords || overBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    // A single record larger than maxBytes still ships alone; the API
    // rejects it and the error surfaces through the sink's error channel.
    current.push(record);
    currentBytes += size;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
};
