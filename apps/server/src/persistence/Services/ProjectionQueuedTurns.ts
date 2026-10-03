import {
  ChatAttachment,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  MessageOrigin,
  ModelSelection,
  OrchestrationProposedPlanId,
  ProviderInteractionMode,
  QueuedTurnId,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionQueuedTurn = Schema.Struct({
  queuedTurnId: QueuedTurnId,
  threadId: ThreadId,
  messageId: MessageId,
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  origin: Schema.NullOr(MessageOrigin),
  modelSelection: Schema.NullOr(ModelSelection),
  titleSeed: Schema.NullOr(Schema.String),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /**
   * Per-thread delivery order. Null only for rows replayed from an event log
   * written before explicit ordering existed; the create path assigns
   * `max(existing) + 1` so appends stay FIFO.
   */
  queuePosition: Schema.NullOr(NonNegativeInt),
  failedAt: Schema.NullOr(IsoDateTime),
  failureMessage: Schema.NullOr(Schema.String),
});
export type ProjectionQueuedTurn = typeof ProjectionQueuedTurn.Type;

export const ProjectionQueuedTurnIdInput = Schema.Struct({
  queuedTurnId: QueuedTurnId,
});
export type ProjectionQueuedTurnIdInput = typeof ProjectionQueuedTurnIdInput.Type;

export const ProjectionQueuedTurnsByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProjectionQueuedTurnsByThreadInput = typeof ProjectionQueuedTurnsByThreadInput.Type;

export interface ProjectionQueuedTurnRepositoryShape {
  readonly upsert: (row: ProjectionQueuedTurn) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getById: (
    input: ProjectionQueuedTurnIdInput,
  ) => Effect.Effect<Option.Option<ProjectionQueuedTurn>, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ProjectionQueuedTurnsByThreadInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionQueuedTurn>, ProjectionRepositoryError>;
  readonly deleteById: (
    input: ProjectionQueuedTurnIdInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: ProjectionQueuedTurnsByThreadInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionQueuedTurnRepository extends Context.Service<
  ProjectionQueuedTurnRepository,
  ProjectionQueuedTurnRepositoryShape
>()("t3/persistence/Services/ProjectionQueuedTurns/ProjectionQueuedTurnRepository") {}
