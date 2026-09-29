/**
 * ProjectionThreadActivityRepository - Projection repository interface for thread activity.
 *
 * Owns persistence operations for activity timeline entries projected from
 * orchestration events.
 *
 * @module ProjectionThreadActivityRepository
 */
import {
  EventId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationThreadActivityTone,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Schema, Context } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadActivity = Schema.Struct({
  activityId: EventId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  tone: OrchestrationThreadActivityTone,
  kind: Schema.String,
  summary: Schema.String,
  payload: Schema.Unknown,
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type ProjectionThreadActivity = typeof ProjectionThreadActivity.Type;

export const ListProjectionThreadActivitiesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadActivitiesInput = typeof ListProjectionThreadActivitiesInput.Type;

export const DeleteProjectionThreadActivitiesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadActivitiesInput =
  typeof DeleteProjectionThreadActivitiesInput.Type;

export const DeleteProjectionThreadActivitiesByTurnIdsInput = Schema.Struct({
  threadId: ThreadId,
  turnIds: Schema.Array(TurnId),
});
export type DeleteProjectionThreadActivitiesByTurnIdsInput =
  typeof DeleteProjectionThreadActivitiesByTurnIdsInput.Type;

export const ListProjectionThreadUserInputActivitiesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadUserInputActivitiesInput =
  typeof ListProjectionThreadUserInputActivitiesInput.Type;

export const HasProjectionThreadActivityKindForTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  kind: Schema.String,
});
export type HasProjectionThreadActivityKindForTurnInput =
  typeof HasProjectionThreadActivityKindForTurnInput.Type;

/**
 * Narrow activity row for user-input lifecycle derivation: kind plus
 * payload only, without tone or summary columns.
 *
 * Returned in ascending `(createdAt, activityId)` order.
 */
export const ProjectionThreadUserInputActivity = Schema.Struct({
  activityId: EventId,
  kind: Schema.String,
  payload: Schema.Unknown,
  createdAt: IsoDateTime,
});
export type ProjectionThreadUserInputActivity = typeof ProjectionThreadUserInputActivity.Type;

/**
 * ProjectionThreadActivityRepositoryShape - Service API for projected thread activity.
 */
export interface ProjectionThreadActivityRepositoryShape {
  /**
   * Insert or replace a projected thread activity row.
   *
   * Upserts by `activityId` and JSON-encodes payload.
   */
  readonly upsert: (
    row: ProjectionThreadActivity,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * List projected thread activity rows for a thread.
   *
   * Returned in ascending runtime sequence order (or creation order when
   * sequence is unavailable).
   */
  readonly listByThreadId: (
    input: ListProjectionThreadActivitiesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadActivity>, ProjectionRepositoryError>;
  readonly getById: (input: {
    readonly threadId: ThreadId;
    readonly activityId: EventId;
  }) => Effect.Effect<
    import("effect").Option.Option<ProjectionThreadActivity>,
    ProjectionRepositoryError
  >;

  /**
   * List only user-input lifecycle activities for a thread
   * (`user-input.requested`, `user-input.resolved`,
   * `provider.user-input.respond.failed`).
   *
   * Returned in ascending `(createdAt, activityId)` order. Narrower and
   * cheaper than `listByThreadId`: unrelated activity payloads are never
   * fetched or JSON-decoded.
   */
  readonly listUserInputLifecycleByThreadId: (
    input: ListProjectionThreadUserInputActivitiesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadUserInputActivity>, ProjectionRepositoryError>;

  /**
   * Checks whether a concrete turn has a projected activity of the requested kind.
   */
  readonly hasKindForTurn: (
    input: HasProjectionThreadActivityKindForTurnInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;

  /**
   * Delete projected thread activity rows by thread.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadActivitiesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * List distinct non-null turn ids with activity rows for a thread.
   *
   * Narrow index read without payloads; used to compute the trimmed turn set
   * for revert without hydrating full histories.
   */
  readonly listTurnIdsByThreadId: (
    input: ListProjectionThreadActivitiesInput,
  ) => Effect.Effect<ReadonlyArray<TurnId>, ProjectionRepositoryError>;

  /**
   * Delete activities of exactly the listed turns of a thread.
   *
   * Turn-less activities are never touched. Unlike `deleteByThreadId` +
   * re-upserting kept rows, this never reads payloads and never rewrites
   * retained rows. An empty `turnIds` list deletes nothing.
   */
  readonly deleteByTurnIds: (
    input: DeleteProjectionThreadActivitiesByTurnIdsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadActivityRepository - Service tag for thread activity persistence.
 */
export class ProjectionThreadActivityRepository extends Context.Service<
  ProjectionThreadActivityRepository,
  ProjectionThreadActivityRepositoryShape
>()("t3/persistence/Services/ProjectionThreadActivities/ProjectionThreadActivityRepository") {}
