import {
  CheckpointRef,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointStatus,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Option, ServiceMap, Schema } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionCheckpoint = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type ProjectionCheckpoint = typeof ProjectionCheckpoint.Type;

export const ListByThreadIdInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListByThreadIdInput = typeof ListByThreadIdInput.Type;

export const GetByThreadAndTurnCountInput = Schema.Struct({
  threadId: ThreadId,
  checkpointTurnCount: NonNegativeInt,
});
export type GetByThreadAndTurnCountInput = typeof GetByThreadAndTurnCountInput.Type;

export const DeleteByThreadIdInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteByThreadIdInput = typeof DeleteByThreadIdInput.Type;

export interface ProjectionCheckpointRepositoryShape {
  readonly upsert: (row: ProjectionCheckpoint) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly listByThreadId: (
    input: ListByThreadIdInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionCheckpoint>, ProjectionRepositoryError>;

  readonly getByThreadAndTurnCount: (
    input: GetByThreadAndTurnCountInput,
  ) => Effect.Effect<Option.Option<ProjectionCheckpoint>, ProjectionRepositoryError>;

  readonly deleteByThreadId: (
    input: DeleteByThreadIdInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionCheckpointRepository extends ServiceMap.Service<
  ProjectionCheckpointRepository,
  ProjectionCheckpointRepositoryShape
>()("persistence/ProjectionCheckpointRepository") {}
