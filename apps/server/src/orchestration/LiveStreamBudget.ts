import { OrchestrationGetSnapshotError } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

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
  const failed = yield* Deferred.make<never, OrchestrationGetSnapshotError>();
  const cleanupComplete = yield* Deferred.make<void>();
  let failure: OrchestrationGetSnapshotError | undefined;
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
    failure ??= new OrchestrationGetSnapshotError({
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

  // Replace one coalescing batch atomically. Queued and coalesced payloads
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
            OrchestrationGetSnapshotError: (error) =>
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
    );

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
