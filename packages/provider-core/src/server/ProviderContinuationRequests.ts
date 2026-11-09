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
  /** Waits until no request for the thread is offered and unsettled; true when it had to wait. */
  readonly awaitSettled: (threadId: ThreadId) => Effect.Effect<boolean>;
}>("@t3tools/provider-core/server/ProviderContinuationRequests", {
  defaultValue: () => ({
    offer: () => Effect.void,
    take: Effect.never,
    settle: () => Effect.void,
    awaitSettled: () => Effect.succeed(false),
  }),
}) {}

export const layer = Layer.effect(
  ProviderContinuationRequests,
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderContinuationRequest>();
    const pending = yield* SubscriptionRef.make<ReadonlyMap<ThreadId, number>>(new Map());
    const adjustPending = (threadId: ThreadId, delta: 1 | -1) =>
      SubscriptionRef.update(pending, (current) => {
        const count = (current.get(threadId) ?? 0) + delta;
        const updated = new Map(current);
        if (count > 0) updated.set(threadId, count);
        else updated.delete(threadId);
        return updated;
      });
    return {
      offer: Effect.fn("ProviderContinuationRequests.offer")(function* (
        request: ProviderContinuationRequest,
      ) {
        yield* adjustPending(request.threadId, 1);
        yield* Queue.offer(queue, request);
      }),
      take: Queue.take(queue),
      settle: Effect.fn("ProviderContinuationRequests.settle")(function* (threadId: ThreadId) {
        yield* adjustPending(threadId, -1);
      }),
      awaitSettled: Effect.fn("ProviderContinuationRequests.awaitSettled")(function* (
        threadId: ThreadId,
      ) {
        if (!(yield* SubscriptionRef.get(pending)).has(threadId)) return false;
        yield* SubscriptionRef.changes(pending).pipe(
          Stream.filter((current) => !current.has(threadId)),
          Stream.take(1),
          Stream.runDrain,
        );
        return true;
      }),
    };
  }),
);
