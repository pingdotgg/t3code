import type {
  OrchestrationEvent,
  OrchestrationGetSnapshotError,
  OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { projectActivityEvent } from "./ActivityPayloadProjection.ts";
import { makeLiveStreamBudget, type RetainedLiveItem } from "./LiveStreamBudget.ts";

const COALESCE_WINDOW = Duration.millis(50);
const MAX_PENDING_UPDATES = 512;

export type ThreadLiveInput =
  | { readonly kind: "event"; readonly event: OrchestrationEvent }
  | { readonly kind: "synchronized" };

function isToolUpdated(event: OrchestrationEvent): boolean {
  return (
    event.type === "thread.activity-appended" && event.payload.activity.kind === "tool.updated"
  );
}

function asTrimmedString(value: unknown): string | null {
  if (!Predicate.isString(value)) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stableToolCallIdentity(event: OrchestrationEvent): string | null {
  if (event.type !== "thread.activity-appended") {
    return null;
  }
  const payload = event.payload.activity.payload;
  if (!Predicate.isObject(payload)) {
    return null;
  }
  const data = Predicate.isObject(payload.data) ? payload.data : null;
  return asTrimmedString(payload.toolCallId) ?? asTrimmedString(data?.toolCallId);
}

/**
 * Retain only the latest in-flight update for each stable tool-call id in a
 * live run. Anonymous calls pass through because labels are not unique when
 * tools execute in parallel. Survivors remain in sequence order.
 */
export function coalesceLiveToolUpdatedEvents(
  events: ReadonlyArray<OrchestrationEvent>,
): ReadonlyArray<OrchestrationEvent> {
  const survivors: Array<OrchestrationEvent> = [];
  let pendingUpdates: Array<OrchestrationEvent> = [];

  const flushUpdates = () => {
    const seen = new Set<string>();
    const latestUpdates: Array<OrchestrationEvent> = [];
    for (let index = pendingUpdates.length - 1; index >= 0; index -= 1) {
      const event = pendingUpdates[index]!;
      const identity = stableToolCallIdentity(event);
      const activity =
        event.type === "thread.activity-appended" ? event.payload.activity : undefined;
      const key = identity ? `${activity?.turnId ?? ""}\u0000${identity}` : null;
      if (key && seen.has(key)) {
        continue;
      }
      if (key) {
        seen.add(key);
      }
      latestUpdates.push(event);
    }
    latestUpdates.reverse();
    survivors.push(...latestUpdates);
    pendingUpdates = [];
  };

  for (const event of events) {
    if (isToolUpdated(event)) {
      pendingUpdates.push(event);
      continue;
    }
    flushUpdates();
    survivors.push(event);
  }
  flushUpdates();
  return survivors;
}

export const makeThreadLiveEventCoalescer = Effect.fn("makeThreadLiveEventCoalescer")(
  function* (options?: {
    readonly coalesceWindow?: Duration.Input;
    readonly maxItems?: number;
    readonly maxSerializedBytes?: number;
  }) {
    const coalescerScope = yield* Effect.scope;
    const budget = yield* makeLiveStreamBudget(options);
    const cleanupComplete = yield* Deferred.make<void>();
    const output = yield* Queue.unbounded<
      RetainedLiveItem<OrchestrationThreadStreamItem>,
      OrchestrationGetSnapshotError
    >();
    const mutex = yield* Semaphore.make(1);
    const coalesceWindow = options?.coalesceWindow ?? COALESCE_WINDOW;
    let pendingUpdates: Array<RetainedLiveItem<OrchestrationEvent>> = [];
    let windowGeneration = 0;
    let windowFiber: Fiber.Fiber<void, never> | null = null;
    let closed = false;

    const cancelWindow = Effect.fn("ThreadLiveEventCoalescer.cancelWindow")(function* () {
      const fiber = windowFiber;
      if (!fiber) {
        return;
      }
      windowFiber = null;
      yield* Fiber.interrupt(fiber);
    });

    const flushPending = Effect.fn("ThreadLiveEventCoalescer.flushPending")(function* () {
      if (pendingUpdates.length === 0) {
        return;
      }
      const items = yield* budget.replace(
        pendingUpdates,
        coalesceLiveToolUpdatedEvents(pendingUpdates.map((item) => item.value)).map((event) => ({
          kind: "event" as const,
          event,
        })),
        (item) => item.event,
      );
      pendingUpdates = [];
      yield* Queue.offerAll(output, items);
    }, Effect.uninterruptible);

    const flushWindow = (generation: number) =>
      Effect.sleep(coalesceWindow).pipe(
        Effect.andThen(
          mutex.withPermits(1)(
            Effect.suspend(() => (generation === windowGeneration ? flushPending() : Effect.void)),
          ),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (generation === windowGeneration) {
              windowFiber = null;
            }
          }),
        ),
        Effect.catchTags({ OrchestrationGetSnapshotError: () => Effect.void }),
      );

    // Keep each source batch together so a synchronization marker cannot pass
    // events already pulled from PubSub but still being coalesced.
    const offerAll = Effect.fn("ThreadLiveEventCoalescer.offerAll")(function* (
      inputs: ReadonlyArray<ThreadLiveInput>,
    ) {
      yield* mutex.withPermits(1)(
        Effect.forEach(
          inputs,
          (input) =>
            Effect.gen(function* () {
              yield* budget.check;
              if (input.kind === "event") {
                // Retain only the client payload, not full persisted tool output.
                yield* budget.retain(projectActivityEvent(input.event)).pipe(
                  Effect.tap((item) => Effect.sync(() => pendingUpdates.push(item))),
                  Effect.uninterruptible,
                );
              }
              if (input.kind === "event" && isToolUpdated(input.event)) {
                if (pendingUpdates.length === 1) {
                  const generation = ++windowGeneration;
                  windowFiber = yield* Effect.forkIn(flushWindow(generation), coalescerScope);
                }
                if (pendingUpdates.length >= MAX_PENDING_UPDATES) {
                  yield* cancelWindow();
                  windowGeneration += 1;
                  yield* flushPending();
                }
                return;
              }

              yield* cancelWindow();
              windowGeneration += 1;
              // A non-update event closes the run immediately. The coalescer keeps
              // that boundary after the final update from the run.
              yield* flushPending();
              if (input.kind === "synchronized") {
                yield* budget.retain({ kind: "synchronized" as const }).pipe(
                  Effect.flatMap((marker) => Queue.offer(output, marker)),
                  Effect.uninterruptible,
                );
              }
            }),
          { discard: true },
        ),
      );
    });

    const close = (error?: OrchestrationGetSnapshotError) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          if (closed) {
            return;
          }
          closed = true;
          windowGeneration += 1;
          yield* cancelWindow();
          budget.release(pendingUpdates);
          pendingUpdates = [];
          budget.release(yield* Queue.clear(output).pipe(Effect.orDie));
          if (error) {
            yield* Queue.fail(output, error);
          }
          yield* Queue.shutdown(output);
          yield* Deferred.succeed(cleanupComplete, undefined);
        }),
      );

    yield* Effect.addFinalizer(() => close());
    yield* budget.failed.pipe(
      Effect.catchTags({ OrchestrationGetSnapshotError: close }),
      Effect.forkScoped,
    );

    return {
      offer: (input: ThreadLiveInput) => offerAll([input]),
      offerAll,
      stream: budget.deliver(Stream.fromQueue(output)),
      failed: budget.failed,
      closed: Deferred.await(cleanupComplete),
      usage: budget.usage,
    } as const;
  },
);
