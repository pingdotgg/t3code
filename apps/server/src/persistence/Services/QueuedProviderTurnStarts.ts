import { MessageId, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const QueuedProviderTurnStart = Schema.Struct({
  eventSequence: NonNegativeInt,
  threadId: ThreadId,
  messageId: MessageId,
});
export type QueuedProviderTurnStart = typeof QueuedProviderTurnStart.Type;

export const QueuedProviderTurnStartSequence = Schema.Struct({
  eventSequence: NonNegativeInt,
});
export type QueuedProviderTurnStartSequence = typeof QueuedProviderTurnStartSequence.Type;

export interface QueuedProviderTurnStartRepositoryShape {
  readonly enqueue: (
    row: QueuedProviderTurnStart,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly list: () => Effect.Effect<
    ReadonlyArray<QueuedProviderTurnStart>,
    ProjectionRepositoryError
  >;
  readonly delete: (
    input: QueuedProviderTurnStartSequence,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class QueuedProviderTurnStartRepository extends Context.Service<
  QueuedProviderTurnStartRepository,
  QueuedProviderTurnStartRepositoryShape
>()("t3/persistence/Services/QueuedProviderTurnStartRepository") {}
