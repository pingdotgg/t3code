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
} from "./LiveStreamBudget.ts";

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
  return input.event.type === "turn-item.updated" && input.event.payload.id
    ? `${input.event.threadId}\u0000${input.event.runId ?? ""}\u0000${input.event.payload.id}`
    : null;
}

/** Retain the newest running tool update per call; lifecycle events flush the window. */
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
    const pendingUpdates = new Map<string, RetainedLiveItem<ThreadLiveEvent>>();
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
      if (pendingUpdates.size === 0) {
        return;
      }
      const items = Array.from(pendingUpdates.values());
      pendingUpdates.clear();
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
              const key =
                input.kind === "event" && isToolUpdated(input)
                  ? stableToolCallIdentity(input)
                  : null;
              if (input.kind === "event" && key !== null) {
                const startsWindow = pendingUpdates.size === 0;
                const previous = pendingUpdates.get(key);
                // Charge only the newest full update for this call. Waiting until
                // flush to coalesce can overflow on data we would discard anyway.
                yield* budget.replace(previous ? [previous] : [], [input]).pipe(
                  Effect.tap(([item]) =>
                    Effect.sync(() => {
                      pendingUpdates.delete(key);
                      pendingUpdates.set(key, item!);
                    }),
                  ),
                  Effect.uninterruptible,
                );
                if (startsWindow) {
                  const generation = ++windowGeneration;
                  windowFiber = yield* Effect.forkIn(flushWindow(generation), coalescerScope);
                }
                if (pendingUpdates.size >= MAX_PENDING_UPDATES) {
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
              yield* budget.retain(input).pipe(
                Effect.flatMap((item) => Queue.offer(output, item)),
                Effect.uninterruptible,
              );
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
          budget.release(pendingUpdates.values());
          pendingUpdates.clear();
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
