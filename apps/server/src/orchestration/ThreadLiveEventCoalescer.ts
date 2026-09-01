import type { OrchestrationEvent, OrchestrationThreadStreamItem } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { projectActivityEvent } from "./ActivityPayloadProjection.ts";

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
  function* (options?: { readonly coalesceWindow?: Duration.Input }) {
    const output = yield* Queue.unbounded<OrchestrationThreadStreamItem>();
    const input = yield* Queue.unbounded<{
      readonly value: ThreadLiveInput;
      readonly processed?: Deferred.Deferred<void>;
    }>();
    const mutex = yield* Semaphore.make(1);
    const coalesceWindow = options?.coalesceWindow ?? COALESCE_WINDOW;
    let pendingUpdates: Array<OrchestrationEvent> = [];
    let windowGeneration = 0;
    let windowFiber: Fiber.Fiber<void, never> | null = null;

    const cancelWindow = Effect.fn("ThreadLiveEventCoalescer.cancelWindow")(function* () {
      const fiber = windowFiber;
      if (!fiber) {
        return;
      }
      windowFiber = null;
      yield* Fiber.interrupt(fiber);
    });

    const flushPending = Effect.fn("ThreadLiveEventCoalescer.flushPending")(function* (
      boundary?: OrchestrationEvent,
    ) {
      const events = boundary ? [...pendingUpdates, boundary] : pendingUpdates;
      pendingUpdates = [];
      if (events.length === 0) {
        return;
      }
      yield* Queue.offerAll(
        output,
        coalesceLiveToolUpdatedEvents(events).map((event) => ({
          kind: "event" as const,
          event: projectActivityEvent(event),
        })),
      );
    });

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

    const process = Effect.fn("ThreadLiveEventCoalescer.process")(function* (
      input: ThreadLiveInput,
    ) {
      yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          if (input.kind === "event" && isToolUpdated(input.event)) {
            pendingUpdates.push(input.event);
            if (pendingUpdates.length === 1) {
              const generation = ++windowGeneration;
              windowFiber = yield* Effect.forkScoped(flushWindow(generation));
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
          if (input.kind === "event") {
            yield* flushPending(input.event);
          } else {
            yield* flushPending();
            yield* Queue.offer(output, { kind: "synchronized" });
          }
        }),
      );
    });

    yield* Stream.fromQueue(input).pipe(
      Stream.runForEach(({ value, processed }) =>
        process(value).pipe(
          Effect.andThen(processed ? Deferred.succeed(processed, undefined) : Effect.void),
        ),
      ),
      Effect.forkScoped,
    );

    const offer = (value: ThreadLiveInput) => Queue.offer(input, { value }).pipe(Effect.asVoid);

    // Synchronization callers wait for their marker to pass through the same
    // ordered input queue before draining output produced ahead of it.
    const offerAndWait = Effect.fn("ThreadLiveEventCoalescer.offerAndWait")(function* (
      value: ThreadLiveInput,
    ) {
      const processed = yield* Deferred.make<void>();
      yield* Queue.offer(input, { value, processed });
      yield* Deferred.await(processed);
    });

    return {
      offer,
      offerAndWait,
      stream: Stream.fromQueue(output),
      takeAll: Queue.takeAll(output),
    } as const;
  },
);
