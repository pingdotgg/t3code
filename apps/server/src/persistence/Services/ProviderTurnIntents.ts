/**
 * ProviderTurnIntentRepository - Durable provider turn handoff intents.
 *
 * Each row represents one committed `thread.turn-start-requested` event that
 * has not yet been handed to the provider runtime.
 *
 * @module ProviderTurnIntentRepository
 */
import { IsoDateTime, MessageId, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProviderTurnIntent = Schema.Struct({
  eventSequence: NonNegativeInt,
  threadId: ThreadId,
  messageId: MessageId,
  requestedAt: IsoDateTime,
});
export type ProviderTurnIntent = typeof ProviderTurnIntent.Type;

export const DeleteProviderTurnIntentInput = Schema.Struct({
  eventSequence: NonNegativeInt,
});
export type DeleteProviderTurnIntentInput = typeof DeleteProviderTurnIntentInput.Type;

export const ProviderTurnIntentThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderTurnIntentThreadInput = typeof ProviderTurnIntentThreadInput.Type;

export const ProviderTurnIntentExactInput = Schema.Struct({
  eventSequence: NonNegativeInt,
  threadId: ThreadId,
});
export type ProviderTurnIntentExactInput = typeof ProviderTurnIntentExactInput.Type;

export interface ProviderTurnIntentRepositoryShape {
  /** Persist one turn-start intent idempotently by its immutable event sequence. */
  readonly insert: (intent: ProviderTurnIntent) => Effect.Effect<void, ProjectionRepositoryError>;

  /** List pending provider handoffs in durable event order. */
  readonly listPending: () => Effect.Effect<
    ReadonlyArray<ProviderTurnIntent>,
    ProjectionRepositoryError
  >;

  /** Check whether a thread has any provider handoff awaiting adoption. */
  readonly hasPendingForThread: (
    input: ProviderTurnIntentThreadInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;

  /** Read one exact intent without consuming it. */
  readonly getExact: (
    input: ProviderTurnIntentExactInput,
  ) => Effect.Effect<Option.Option<ProviderTurnIntent>, ProjectionRepositoryError>;

  /** Atomically consume and return one exact intent. */
  readonly takeExact: (
    input: ProviderTurnIntentExactInput,
  ) => Effect.Effect<Option.Option<ProviderTurnIntent>, ProjectionRepositoryError>;

  /** Atomically consume and return the oldest intent for a thread. */
  readonly takeOldestForThread: (
    input: ProviderTurnIntentThreadInput,
  ) => Effect.Effect<Option.Option<ProviderTurnIntent>, ProjectionRepositoryError>;

  /** Delete exactly one completed handoff by its immutable event sequence. */
  readonly deleteByEventSequence: (
    input: DeleteProviderTurnIntentInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Delete one handoff only when both its thread and event sequence match. */
  readonly deleteExact: (
    input: ProviderTurnIntentExactInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;

  /** Consume the only/oldest pending handoff for a thread, if one exists. */
  readonly consumeOldestForThread: (
    input: ProviderTurnIntentThreadInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;
}

export class ProviderTurnIntentRepository extends Context.Service<
  ProviderTurnIntentRepository,
  ProviderTurnIntentRepositoryShape
>()("t3/persistence/Services/ProviderTurnIntents/ProviderTurnIntentRepository") {}
