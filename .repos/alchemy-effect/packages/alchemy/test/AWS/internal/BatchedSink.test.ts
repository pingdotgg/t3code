import {
  BatchRetryExhaustedError,
  makeBatchedSink,
} from "@/AWS/internal/BatchedSink.ts";
import { describe, expect, it } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

/**
 * Pure tests of the shared batch-sink engine (`AWS/internal/BatchedSink.ts`)
 * with an injected `send`. Live end-to-end coverage of the three rebased
 * sinks (SQS `QueueSink`, SNS `TopicSink`, Kinesis `StreamSink`) lives in
 * their fixture tests; partial-failure classification cannot be forced
 * deterministically against real AWS, so the retry semantics are proven here.
 */

class SendFailure extends Data.TaggedError("SendFailure")<{
  readonly reason: string;
}> {}

interface FakeOut {
  /** Indices (relative to the sent batch) reported as transiently unprocessed. */
  readonly unprocessed?: readonly number[];
  /** Indices (relative to the sent batch) reported as permanently rejected. */
  readonly rejected?: readonly number[];
}

const byIndex = <In>(
  indices: readonly number[] | undefined,
  batch: readonly In[],
): readonly In[] => {
  if (indices === undefined || indices.length === 0) {
    return [];
  }
  const set = new Set(indices);
  return batch.filter((_, index) => set.has(index));
};

const instant = Schedule.recurs(3);

describe("makeBatchedSink", () => {
  it.effect("splits a chunk into maxRecords batches preserving order", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<(readonly number[])[]>([]);
      const sink = makeBatchedSink<number, FakeOut, never>({
        maxRecords: 3,
        send: (batch) =>
          Ref.update(sent, (batches) => [...batches, batch]).pipe(
            Effect.as({}),
          ),
      });

      yield* Stream.make(1, 2, 3, 4, 5, 6, 7, 8).pipe(Stream.run(sink));

      expect(yield* Ref.get(sent)).toEqual([
        [1, 2, 3],
        [4, 5, 6],
        [7, 8],
      ]);
    }),
  );

  it.effect("packs greedily by maxBytes using sizeOf", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<(readonly string[])[]>([]);
      const sink = makeBatchedSink<string, FakeOut, never>({
        maxRecords: 10,
        maxBytes: 5,
        sizeOf: (record) => record.length,
        send: (batch) =>
          Ref.update(sent, (batches) => [...batches, batch]).pipe(
            Effect.as({}),
          ),
      });

      // each record is 2 bytes; 3 records would be 6 > 5, so batches of 2
      yield* Stream.make("aa", "bb", "cc", "dd", "ee").pipe(Stream.run(sink));

      expect(yield* Ref.get(sent)).toEqual([
        ["aa", "bb"],
        ["cc", "dd"],
        ["ee"],
      ]);
    }),
  );

  it.effect("re-submits only the unprocessed subset until it converges", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<(readonly number[])[]>([]);
      const sink = makeBatchedSink<number, FakeOut, never>({
        maxRecords: 10,
        retrySchedule: instant,
        send: (batch) =>
          Effect.gen(function* () {
            const attempt = (yield* Ref.get(sent)).length;
            yield* Ref.update(sent, (batches) => [...batches, batch]);
            // first call: report the last two entries as unprocessed;
            // second call: everything succeeds.
            return attempt === 0
              ? { unprocessed: [batch.length - 2, batch.length - 1] }
              : {};
          }),
        unprocessed: (out, batch) => byIndex(out.unprocessed, batch),
      });

      yield* Stream.make(1, 2, 3, 4).pipe(Stream.run(sink));

      expect(yield* Ref.get(sent)).toEqual([
        [1, 2, 3, 4],
        [3, 4],
      ]);
    }),
  );

  it.effect(
    "fails with BatchRetryExhaustedError carrying the stranded entries",
    () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        const sink = makeBatchedSink<number, FakeOut, never>({
          maxRecords: 10,
          retrySchedule: Schedule.recurs(2),
          send: (batch) =>
            Ref.update(calls, (n) => n + 1).pipe(
              // the last entry is reported unprocessed forever
              Effect.as({ unprocessed: [batch.length - 1] }),
            ),
          unprocessed: (out, batch) => byIndex(out.unprocessed, batch),
        });

        const error = yield* Stream.make(1, 2, 3).pipe(
          Stream.run(sink),
          Effect.flip,
        );

        expect(error._tag).toBe("BatchRetryExhaustedError");
        expect((error as BatchRetryExhaustedError<number>).entries).toEqual([
          3,
        ]);
        // initial attempt + 2 bounded retries
        expect(yield* Ref.get(calls)).toBe(3);
      }),
  );

  it.effect("drops rejected entries without retrying and surfaces them", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const rejected = yield* Ref.make<readonly number[]>([]);
      const sink = makeBatchedSink<number, FakeOut, never>({
        maxRecords: 10,
        retrySchedule: instant,
        send: () =>
          Ref.update(calls, (n) => n + 1).pipe(
            // the middle entry is permanently rejected; nothing is retried
            Effect.as({ rejected: [1] } satisfies FakeOut),
          ),
        unprocessed: (out, batch) => byIndex(out.unprocessed, batch),
        rejected: (out, batch) => byIndex(out.rejected, batch),
        onRejected: (entries) => Ref.set(rejected, entries),
      });

      yield* Stream.make(1, 2, 3).pipe(Stream.run(sink));

      expect(yield* Ref.get(calls)).toBe(1);
      expect(yield* Ref.get(rejected)).toEqual([2]);
    }),
  );

  it.effect("propagates send errors through the sink error channel", () =>
    Effect.gen(function* () {
      const sink = makeBatchedSink<number, FakeOut, SendFailure>({
        maxRecords: 10,
        send: () => Effect.fail(new SendFailure({ reason: "boom" })),
      });

      const error = yield* Stream.make(1).pipe(Stream.run(sink), Effect.flip);

      expect(error._tag).toBe("SendFailure");
    }),
  );
});
