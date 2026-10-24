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
  /**
   * `adapter_buffered` (default) is the provider-native wake: the adapter has already buffered the
   * CLI's wake output, and the dispatched message only triggers ingestion. `message_text` is for
   * app-owned work with no buffered provider output, such as a delegated child finishing.
   */
  readonly delivery?: "adapter_buffered" | "message_text";
  readonly messageId?: MessageId;
  readonly dispatchIfCurrent?: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
  readonly clearIfCurrent?: () => Effect.Effect<void>;
  /** Runs once the run woken by this request reaches a terminal status, however it got there. */
  readonly onRunSettled?: () => Effect.Effect<void>;
}

/**
 * The default reference drops requests, keeping adapter construction dependency-free in tests; the
 * live layer must be shared with the ProviderContinuationService worker that drains it.
 */
export class ProviderContinuationRequests extends Context.Reference<{
  readonly offer: (request: ProviderContinuationRequest) => Effect.Effect<void>;
  readonly take: Effect.Effect<ProviderContinuationRequest>;
}>("@t3tools/provider-core/server/ProviderContinuationRequests", {
  defaultValue: () => ({ offer: () => Effect.void, take: Effect.never }),
}) {}

export const layer = Layer.effect(
  ProviderContinuationRequests,
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<ProviderContinuationRequest>();
    return {
      offer: (request: ProviderContinuationRequest) =>
        Queue.offer(queue, request).pipe(Effect.asVoid),
      take: Queue.take(queue),
    };
  }),
);
