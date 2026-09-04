import * as Schema from "effect/Schema";
import * as Arr from "effect/Array";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export class LiveStreamBufferError extends Schema.TaggedErrorClass<LiveStreamBufferError>()(
  "LiveStreamBufferError",
  { message: Schema.String },
) {}

export const LIVE_STREAM_MAX_ITEMS = 1_000;
export const LIVE_STREAM_MAX_SERIALIZED_BYTES = 8 * 1024 * 1024;

export interface RetainedLiveItem<A> {
  readonly value: A;
  readonly serializedBytes: number;
}

// Published events are immutable and shared across subscriptions. Measure each
// object once without keeping the event or its serialized copy alive.
const serializedSizes = new WeakMap<object, number>();

function serializedSize(value: object): number {
  const cached = serializedSizes.get(value);
  if (cached !== undefined) {
    return cached;
  }
  const bytes = Buffer.byteLength(JSON.stringify(value));
  serializedSizes.set(value, bytes);
  return bytes;
}

/** One budget covers one subscription and its delivery stream, including the batch waiting for an RPC ACK. */
export const makeLiveStreamBudget = Effect.fn("makeLiveStreamBudget")(function* (limits?: {
  readonly maxItems?: number;
  readonly maxSerializedBytes?: number;
}) {
  const maxItems = limits?.maxItems ?? LIVE_STREAM_MAX_ITEMS;
  const maxSerializedBytes = limits?.maxSerializedBytes ?? LIVE_STREAM_MAX_SERIALIZED_BYTES;
  const failed = yield* Deferred.make<never, LiveStreamBufferError>();
  const cleanupComplete = yield* Deferred.make<void>();
  let failure: LiveStreamBufferError | undefined;
  const retained = new Set<RetainedLiveItem<unknown>>();
  let retainedSerializedBytes = 0;

  const release = (items: Iterable<RetainedLiveItem<unknown>>) => {
    for (const item of items) {
      if (!retained.delete(item)) {
        continue;
      }
      retainedSerializedBytes -= item.serializedBytes;
    }
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => release(retained)).pipe(
      Effect.andThen(Deferred.succeed(cleanupComplete, undefined)),
    ),
  );

  const check = Effect.suspend(() => (failure ? Effect.fail(failure) : Effect.void));

  const overflow = Effect.fn("LiveStreamBudget.overflow")(function* (
    nextItems: number,
    nextSerializedBytes: number,
  ) {
    failure ??= new LiveStreamBufferError({
      message: "The live event buffer is full. Resume from the last received sequence.",
    });
    yield* Deferred.fail(failed, failure);
    yield* Effect.logWarning("orchestration live event buffer is full", {
      retainedItems: retained.size,
      retainedSerializedBytes,
      nextItems,
      nextSerializedBytes,
      maxItems,
      maxSerializedBytes,
    });
    return yield* failure;
  });

  const retain = <A extends object>(value: A, payload: object = value) =>
    Effect.suspend(() => {
      if (failure) {
        return Effect.fail(failure);
      }
      const serializedBytes = serializedSize(payload);
      const nextItems = retained.size + 1;
      const nextSerializedBytes = retainedSerializedBytes + serializedBytes;
      if (nextItems > maxItems || nextSerializedBytes > maxSerializedBytes) {
        return overflow(nextItems, nextSerializedBytes);
      }
      const item = { value, serializedBytes };
      retained.add(item);
      retainedSerializedBytes = nextSerializedBytes;
      return Effect.succeed(item);
    });

  // Replace one coalescing batch atomically. Both raw and projected payloads
  // count against the same budget, and discarded updates release their charge.
  const replace = <A extends object>(
    previous: ReadonlyArray<RetainedLiveItem<unknown>>,
    values: ReadonlyArray<A>,
    payload: (value: A) => object = (value) => value,
  ) =>
    Effect.suspend(() => {
      if (failure) {
        return Effect.fail(failure);
      }
      const next = values.map((value) => ({
        value,
        serializedBytes: serializedSize(payload(value)),
      }));
      let nextItems = retained.size + next.length;
      let nextSerializedBytes =
        retainedSerializedBytes + next.reduce((sum, item) => sum + item.serializedBytes, 0);
      for (const item of previous) {
        if (retained.has(item)) {
          nextItems -= 1;
          nextSerializedBytes -= item.serializedBytes;
        }
      }
      if (nextItems > maxItems || nextSerializedBytes > maxSerializedBytes) {
        return overflow(nextItems, nextSerializedBytes);
      }
      release(previous);
      for (const item of next) {
        retained.add(item);
      }
      retainedSerializedBytes = nextSerializedBytes;
      return Effect.succeed(next);
    });

  const deliver = <A, E, R>(stream: Stream.Stream<RetainedLiveItem<A>, E, R>) =>
    Stream.fromPull(
      Effect.gen(function* () {
        yield* check;
        const sourceScope = yield* Scope.fork(yield* Effect.scope);
        const source = {
          pull: yield* Stream.toPull(stream).pipe(Scope.provide(sourceScope)),
        };
        let inFlight: ReadonlyArray<RetainedLiveItem<A>> = [];
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            release(inFlight);
            inFlight = [];
            source.pull = Effect.interrupt;
          }),
        );
        yield* Deferred.await(failed).pipe(
          Effect.catchTags({
            LiveStreamBufferError: (error) =>
              Effect.sync(() => {
                // A grouped source can retain its own pending chunk. Close it
                // and release the pull closure without waiting for an RPC ACK.
                source.pull = Effect.interrupt;
              }).pipe(
                Effect.andThen(Scope.close(sourceScope, Exit.fail(error))),
                Effect.andThen(
                  Effect.sync(() => {
                    const delivered = new Set<RetainedLiveItem<unknown>>(inFlight);
                    for (const item of retained) {
                      if (!delivered.has(item)) {
                        release([item]);
                      }
                    }
                  }),
                ),
                Effect.andThen(Deferred.succeed(cleanupComplete, undefined)),
              ),
          }),
          Effect.forkScoped,
        );
        // @effect-diagnostics-next-line returnEffectInGen:off - Stream.fromPull needs the pull effect as its result.
        return Effect.gen(function* () {
          // RpcServer requests the next batch only after the client ACKs this
          // one. Removing items from a queue alone does not mean delivery ended.
          release(inFlight);
          inFlight = [];
          yield* check;
          const items = yield* Effect.raceFirst(source.pull, Deferred.await(failed));
          inFlight = items;
          yield* check;
          return Arr.map(items, (item) => item.value);
        });
      }),
    ).pipe(Stream.scoped);

  return {
    retain,
    replace,
    release,
    deliver,
    check,
    failed: Deferred.await(failed),
    closed: Deferred.await(cleanupComplete),
    usage: Effect.sync(() => ({ retainedItems: retained.size, retainedSerializedBytes })),
  };
});

type LiveStreamBudget = Effect.Success<ReturnType<typeof makeLiveStreamBudget>>;

type LiveStreamLimits = {
  readonly maxItems?: number;
  readonly maxSerializedBytes?: number;
};

const retainLiveStream = <A extends object, E, R>(
  source: Stream.Stream<A, E, R>,
  budget: LiveStreamBudget,
) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<
      RetainedLiveItem<A>,
      E | LiveStreamBufferError | Cause.Done
    >();
    let closed = false;
    const close = (error?: LiveStreamBufferError) =>
      Effect.gen(function* () {
        if (closed) return;
        closed = true;
        budget.release(yield* Queue.clear(queue).pipe(Effect.orElseSucceed(() => [])));
        if (error) yield* Queue.fail(queue, error);
        yield* Queue.shutdown(queue);
      });
    yield* Effect.addFinalizer(() => close());
    yield* budget.failed.pipe(
      Effect.catchTags({ LiveStreamBufferError: close }),
      Effect.forkScoped,
    );
    yield* source.pipe(
      Stream.runForEach((value) =>
        budget.retain(value).pipe(
          Effect.flatMap((item) => Queue.offer(queue, item)),
          Effect.uninterruptible,
        ),
      ),
      Effect.raceFirst(budget.failed),
      Effect.exit,
      Effect.flatMap((exit) =>
        Exit.isFailure(exit) ? Queue.failCause(queue, exit.cause) : Queue.end(queue),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    return Stream.fromQueue(queue);
  });

/** Drain live events while RPC delivery waits for an ACK, with a bounded retained tail. */
export const bufferLiveStream = <A extends object, E, R>(
  source: Stream.Stream<A, E, R>,
  limits?: LiveStreamLimits,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const budget = yield* makeLiveStreamBudget(limits);
      return budget.deliver(yield* retainLiveStream(source, budget));
    }),
  );

/**
 * Subscribe and start draining before reading the high-water mark. A blocked
 * catch-up query or an unacknowledged replay batch must not strand an unbounded
 * PubSub subscription. Raw replay/live events share one budget here; projected
 * RPC delivery has its own budget, so the two stages retain at most twice the
 * configured item and byte limits.
 */
export const replayAndBufferLiveEvents = <A extends { readonly sequence: number }, E, R>(
  input: {
    readonly subscribe: Effect.Effect<PubSub.Subscription<A>, never, Scope.Scope>;
    readonly latestSequence: Effect.Effect<number, E, R>;
    readonly replay: (throughSequence: number) => Stream.Stream<A, E, R>;
    readonly afterSequence?: number;
    readonly filter?: (event: A) => boolean;
  },
  limits?: LiveStreamLimits,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const budget = yield* makeLiveStreamBudget(limits);
      const subscriptionScope = yield* Scope.fork(yield* Effect.scope);
      const subscription = yield* input.subscribe.pipe(Scope.provide(subscriptionScope));
      let throughSequence = input.afterSequence ?? 0;
      const live = yield* retainLiveStream(
        // Taking one event at a time avoids retaining an uncharged PubSub batch
        // while the drain charges events to the budget.
        Stream.fromEffectRepeat(PubSub.take(subscription)).pipe(
          Stream.filter(
            (event) => event.sequence > throughSequence && (input.filter?.(event) ?? true),
          ),
          Stream.ensuring(Scope.close(subscriptionScope, Exit.void)),
        ),
        budget,
      );
      const replay = Stream.unwrap(
        input.latestSequence.pipe(
          Effect.map((highWater) => {
            throughSequence = Math.max(highWater, input.afterSequence ?? 0);
            return input.replay(highWater).pipe(
              // The finite database page is independent of the live tail.
              // Charge only the item being delivered so a fast reader can
              // consume a page larger than the budget without overflowing.
              Stream.rechunk(1),
              Stream.mapEffect((event) => budget.retain(event)),
            );
          }),
        ),
      );
      return budget.deliver(
        Stream.concat(
          replay,
          live.pipe(
            Stream.filter((item) => {
              if (item.value.sequence > throughSequence) return true;
              // An event published between subscribe and the high-water read
              // is already present in replay.
              budget.release([item]);
              return false;
            }),
          ),
        ),
      );
    }),
  );
