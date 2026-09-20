/**
 * ProviderBusyRetryReactor - Retries turns that failed because the provider was busy.
 *
 * Watches thread session errors that describe temporary provider overload and,
 * after a delay, asks the agent to continue. A user message sent in the
 * meantime always wins over the automatic retry.
 *
 * @module ProviderBusyRetryReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ProviderBusyRetryReactorShape {
  /**
   * Start reacting to thread.session-set orchestration domain events.
   *
   * The returned effect must be run in a scope so pending retries are
   * cancelled on shutdown.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;
}

export class ProviderBusyRetryReactor extends Context.Service<
  ProviderBusyRetryReactor,
  ProviderBusyRetryReactorShape
>()("t3/orchestration/Services/ProviderBusyRetryReactor") {}
