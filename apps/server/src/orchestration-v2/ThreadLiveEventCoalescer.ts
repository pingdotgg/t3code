import type { OrchestrationV2ThreadStreamItem } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  LiveStreamBufferError,
  makeLiveStreamBudget,
  type RetainedLiveItem,
} from "../orchestration/LiveStreamBudget.ts";

const COALESCE_WINDOW = Duration.millis(50);
const MAX_PENDING_UPDATES = 512;

type ThreadLiveEvent = Extract<OrchestrationV2ThreadStreamItem, { readonly kind: "event" }>;
export type ThreadLiveInput = ThreadLiveEvent | { readonly kind: "synchronized" };

function isToolUpdated(input: ThreadLiveEvent): boolean {
  if (input.event.type !== "turn-item.updated" || input.event.payload.status !== "running")
    return false;
  switch (input.event.payload.type) {
    case "command_execution":
    case "file_change":
    case "file_search":
    case "web_search":
    case "dynamic_tool":
      return true;
    default:
      return false;
  }
}

function stableToolCallIdentity(input: ThreadLiveEvent): string | null {
  return input.event.type === "turn-item.updated" ? input.event.payload.id : null;
}

/**
 * Retain only the latest in-flight update for each stable tool-call id in a
 * live run. Item IDs distinguish parallel calls with the same label.
 * Survivors remain in sequence order; terminal updates are never discarded.
 */
export function coalesceLiveToolUpdatedEvents(
  events: ReadonlyArray<ThreadLiveEvent>,
): ReadonlyArray<ThreadLiveEvent> {
  const survivors: Array<ThreadLiveEvent> = [];
  let pendingUpdates: Array<ThreadLiveEvent> = [];

  const flushUpdates = () => {
    const seen = new Set<string>();
    const latestUpdates: Array<ThreadLiveEvent> = [];
    for (let index = pendingUpdates.length - 1; index >= 0; index -= 1) {
      const event = pendingUpdates[index]!;
      const identity = stableToolCallIdentity(event);
      const key = identity
        ? `${event.event.threadId}\u0000${event.event.runId ?? ""}\u0000${identity}`
        : null;
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

export const makeThreadLiveEventCoalescer = <E = never>(options?: {
  readonly coalesceWindow?: Duration.Input;
  readonly maxItems?: number;
  readonly maxSerializedBytes?: number;
}) =>
  Effect.gen(function* () {
    const coalescerScope = yield* Effect.scope;
    const budget = yield* makeLiveStreamBudget(options);
    const cleanupComplete = yield* Deferred.make<void>();
    const output = yield* Queue.unbounded<
      RetainedLiveItem<ThreadLiveInput>,
      E | LiveStreamBufferError | Cause.Done
    >();
    const mutex = yield* Semaphore.make(1);
    const coalesceWindow = options?.coalesceWindow ?? COALESCE_WINDOW;
    let pendingUpdates: Array<RetainedLiveItem<ThreadLiveEvent>> = [];
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
        coalesceLiveToolUpdatedEvents(pendingUpdates.map((item) => item.value)),
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
        Effect.catchTags({ LiveStreamBufferError: () => Effect.void }),
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
                yield* budget.retain(input).pipe(
                  Effect.tap((item) => Effect.sync(() => pendingUpdates.push(item))),
                  Effect.uninterruptible,
                );
              }
              if (input.kind === "event" && isToolUpdated(input)) {
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

    const close = (cause?: Cause.Cause<E | LiveStreamBufferError>) =>
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
          budget.release(yield* Queue.clear(output).pipe(Effect.orElseSucceed(() => [])));
          if (cause) {
            yield* Queue.failCause(output, cause);
          }
          yield* Queue.shutdown(output);
          yield* Deferred.succeed(cleanupComplete, undefined);
        }),
      );

    yield* Effect.addFinalizer(() => close());
    yield* budget.failed.pipe(
      Effect.catchTags({ LiveStreamBufferError: (error) => close(Cause.fail(error)) }),
      Effect.forkScoped,
    );

    return {
      offer: (input: ThreadLiveInput) => offerAll([input]),
      close,
      end: mutex.withPermits(1)(
        Effect.gen(function* () {
          yield* cancelWindow();
          windowGeneration += 1;
          yield* flushPending();
          yield* Queue.end(output);
        }),
      ),
      offerAll,
      stream: budget.deliver(Stream.fromQueue(output)),
      failed: budget.failed,
      closed: Deferred.await(cleanupComplete),
      usage: budget.usage,
    } as const;
  });

/** Keep tool updates within a bounded live window; lifecycle events flush it immediately. */
export const coalesceThreadLiveStream = <E, R>(source: Stream.Stream<ThreadLiveEvent, E, R>) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const coalescer = yield* makeThreadLiveEventCoalescer<E>();
      yield* source.pipe(
        Stream.runForEachArray(coalescer.offerAll),
        Effect.andThen(coalescer.end),
        Effect.raceFirst(coalescer.failed),
        Effect.exit,
        Effect.flatMap((exit) =>
          Exit.isFailure(exit) ? coalescer.close(exit.cause) : Effect.void,
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      return coalescer.stream;
    }),
  );
