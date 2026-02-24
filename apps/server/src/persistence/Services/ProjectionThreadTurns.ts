import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectionThreadTurnStatus,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadTurn = Schema.Struct({
  turnId: TurnId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  status: ProjectionThreadTurnStatus,
  userMessageId: Schema.NullOr(MessageId),
  assistantMessageId: Schema.NullOr(MessageId),
  startedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionThreadTurn = typeof ProjectionThreadTurn.Type;

export const ListProjectionThreadTurnsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadTurnsInput = typeof ListProjectionThreadTurnsInput.Type;

export const GetProjectionThreadTurnInput = Schema.Struct({
  turnId: TurnId,
});
export type GetProjectionThreadTurnInput = typeof GetProjectionThreadTurnInput.Type;

export const DeleteProjectionThreadTurnsInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadTurnsInput = typeof DeleteProjectionThreadTurnsInput.Type;

export interface ProjectionThreadTurnRepositoryShape {
  readonly upsert: (turn: ProjectionThreadTurn) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly listByThreadId: (
    input: ListProjectionThreadTurnsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadTurn>, ProjectionRepositoryError>;

  readonly getByTurnId: (
    input: GetProjectionThreadTurnInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadTurn>, ProjectionRepositoryError>;

  readonly deleteByThreadId: (
    input: DeleteProjectionThreadTurnsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadTurnRepository extends ServiceMap.Service<
  ProjectionThreadTurnRepository,
  ProjectionThreadTurnRepositoryShape
>()("persistence/ProjectionThreadTurnRepository") {}
