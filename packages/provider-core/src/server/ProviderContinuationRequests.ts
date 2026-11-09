import {
  type OrchestrationV2Notification,
  MessageId,
  ProviderDriverKind,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

export interface ProviderContinuationRequest {
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly driver: ProviderDriverKind;
  readonly detail: string | null;
  readonly notification?: OrchestrationV2Notification;
  readonly delegatedCompletion?: {
    readonly parentRunId: RunId;
    readonly generation: number;
    readonly messageId: MessageId;
  };
  /** adapter_buffered (default) ingests existing CLI output; message_text delivers app-owned wake text. */
  readonly delivery?: "adapter_buffered" | "message_text";
  readonly messageId?: MessageId;
  readonly dispatchIfCurrent?: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
  readonly clearIfCurrent?: () => Effect.Effect<void>;
}

/** The default drops requests; share the live layer with the worker that drains them. */
export class ProviderContinuationRequests extends Context.Reference<{
  readonly offer: (request: ProviderContinuationRequest) => Effect.Effect<void>;
  readonly take: Effect.Effect<ProviderContinuationRequest>;
  /** The taker calls this once per request when its dispatch has finished, either way. */
  readonly settle: (threadId: ThreadId) => Effect.Effect<void>;
  /** The thread's offered, unsettled requests, and how many requests have settled in all. */
  readonly progress: (
    threadId: ThreadId,
  ) => Effect.Effect<{ readonly pending: number; readonly settles: number }>;
  /** Waits until more than `settles` requests have settled in all. */
  readonly awaitSettle: (settles: number) => Effect.Effect<void>;
}>("@t3tools/provider-core/server/ProviderContinuationRequests", {
  defaultValue: () => ({
    offer: () => Effect.void,
    take: Effect.never,
    settle: () => Effect.void,
    progress: () => Effect.succeed({ pending: 0, settles: 0 }),
    awaitSettle: () => Effect.void,
  }),
}) {}

export const layer = Layer.effect(
  ProviderContinuationRequests,
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderContinuationRequest>();
    // Settles only grow, so an offer arriving meanwhile cannot hide one from a waiter.
    const state = yield* SubscriptionRef.make<{
      readonly pending: ReadonlyMap<ThreadId, number>;
      readonly settles: number;
    }>({ pending: new Map(), settles: 0 });
    const adjustPending = (threadId: ThreadId, delta: 1 | -1) =>
      SubscriptionRef.update(state, (current) => {
        const count = (current.pending.get(threadId) ?? 0) + delta;
        const pending = new Map(current.pending);
        if (count > 0) pending.set(threadId, count);
        else pending.delete(threadId);
        return { pending, settles: current.settles + (delta < 0 ? 1 : 0) };
      });
    return {
      offer: Effect.fn("ProviderContinuationRequests.offer")(
        function* (request: ProviderContinuationRequest) {
          yield* adjustPending(request.threadId, 1);
          yield* Queue.offer(queue, request);
        },
        // Every count the taker will settle must reach the queue.
        Effect.uninterruptible,
      ),
      take: Queue.take(queue),
      settle: Effect.fn("ProviderContinuationRequests.settle")(function* (threadId: ThreadId) {
        yield* adjustPending(threadId, -1);
      }),
      progress: Effect.fn("ProviderContinuationRequests.progress")(function* (threadId: ThreadId) {
        const current = yield* SubscriptionRef.get(state);
        return { pending: current.pending.get(threadId) ?? 0, settles: current.settles };
      }),
      awaitSettle: Effect.fn("ProviderContinuationRequests.awaitSettle")(function* (
        settles: number,
      ) {
        yield* SubscriptionRef.changes(state).pipe(
          Stream.filter((current) => current.settles > settles),
          Stream.take(1),
          Stream.runDrain,
        );
      }),
    };
  }),
);
