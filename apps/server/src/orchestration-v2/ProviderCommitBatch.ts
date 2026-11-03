import type { OrchestrationV2DomainEvent, OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";

const MAX_EVENTS = 64;
const MAX_BYTES = 1024 * 1024;
const encodeQueue = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const make = Effect.fn("ProviderCommitBatch.make")(function* <E>(
  commit: (
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, E>,
  windowMs: number,
) {
  const scope = yield* Effect.scope;
  const lane = yield* Semaphore.make(1);
  type Pending = {
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly bytes: number;
    readonly result: Deferred.Deferred<ReadonlyArray<OrchestrationV2StoredEvent>, E>;
  };
  let pending: Array<Pending> = [];
  let eventCount = 0;
  let byteCount = 0;
  let generation = 0;
  let closed = false;
  let openedAt = 0;

  // The lane stays held through commit, publication and acknowledgement.
  const flush = Effect.fn("orchestrationV2.EventSink.flushProviderBatch")(function* (
    reason: "deadline" | "limit" | "barrier" | "shutdown",
  ) {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.batch_requests": batch.length,
      "orchestration_v2.event_count": eventCount,
      "orchestration_v2.queued_json_bytes": byteCount,
      "orchestration_v2.batch_threads": new Set(
        batch.flatMap((entry) => entry.events.map((event) => event.threadId)),
      ).size,
      "orchestration_v2.commit_window_ms": windowMs,
      "orchestration_v2.batch_wait_ms": (yield* Clock.currentTimeMillis) - openedAt,
      "orchestration_v2.batch_flush_reason": reason,
    });
    eventCount = 0;
    byteCount = 0;
    generation++;
    const exit = yield* Effect.exit(commit(batch.flatMap((entry) => entry.events)));
    // Unguarded snapshots preserve one stored event per input, in input order.
    let offset = 0;
    for (const entry of batch) {
      yield* Deferred.done(
        entry.result,
        Exit.isFailure(exit)
          ? exit
          : Exit.succeed(exit.value.slice(offset, offset + entry.events.length)),
      );
      offset += entry.events.length;
    }
  }, Effect.uninterruptible);

  yield* Effect.addFinalizer(() =>
    lane.withPermits(1)(
      Effect.sync(() => {
        closed = true;
      }).pipe(Effect.andThen(flush("shutdown"))),
    ),
  );

  // Per-write calls share the batch's tracing boundary.
  const write = Effect.fnUntraced(function* (events: ReadonlyArray<OrchestrationV2DomainEvent>) {
    const result = yield* Deferred.make<ReadonlyArray<OrchestrationV2StoredEvent>, E>();
    const entry: Pending = { events, result, bytes: Buffer.byteLength(yield* encodeQueue(events)) };
    yield* lane.withPermits(1)(
      Effect.gen(function* () {
        if (closed) return yield* Effect.interrupt;
        if (eventCount + events.length > MAX_EVENTS || byteCount + entry.bytes > MAX_BYTES) {
          yield* flush("limit");
        }
        const opensWindow = pending.length === 0;
        if (opensWindow) openedAt = yield* Clock.currentTimeMillis;
        pending.push(entry);
        eventCount += events.length;
        byteCount += entry.bytes;
        if (eventCount >= MAX_EVENTS || byteCount >= MAX_BYTES) {
          yield* flush("limit");
        } else if (opensWindow) {
          const token = ++generation;
          yield* Effect.sleep(windowMs).pipe(
            Effect.andThen(
              lane.withPermits(1)(
                Effect.suspend(() => (token === generation ? flush("deadline") : Effect.void)),
              ),
            ),
            Effect.interruptible,
            Effect.forkIn(scope, { startImmediately: true }),
          );
        }
      }),
    );
    return yield* Deferred.await(result).pipe(
      Effect.onInterrupt(() =>
        lane.withPermits(1)(
          Effect.sync(() => {
            const index = pending.indexOf(entry);
            if (index < 0) return;
            pending.splice(index, 1);
            eventCount -= events.length;
            byteCount -= entry.bytes;
            if (pending.length === 0) generation++;
          }),
        ),
      ),
    );
  });

  const barrier = <A, E2, R>(effect: Effect.Effect<A, E2, R>) =>
    lane.withPermits(1)(
      Effect.suspend(() =>
        closed ? Effect.interrupt : flush("barrier").pipe(Effect.andThen(effect)),
      ),
    );

  return { write, barrier };
});
