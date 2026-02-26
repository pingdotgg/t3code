/**
 * ProjectionPendingTurnStartRepository - Repository interface for pending turn starts.
 *
 * Owns persistence operations for projected "pending turn start" markers used
 * while creating new turns from queued messages.
 *
 * @module ProjectionPendingTurnStartRepository
 */
import { IsoDateTime, MessageId, ThreadId } from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionPendingTurnStart = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  createdAt: IsoDateTime,
});
export type ProjectionPendingTurnStart = typeof ProjectionPendingTurnStart.Type;

export const GetProjectionPendingTurnStartInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionPendingTurnStartInput = typeof GetProjectionPendingTurnStartInput.Type;

export const DeleteProjectionPendingTurnStartInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionPendingTurnStartInput = typeof DeleteProjectionPendingTurnStartInput.Type;

/**
 * ProjectionPendingTurnStartRepositoryShape - Service API for pending turn-start markers.
 */
export interface ProjectionPendingTurnStartRepositoryShape {
  /**
   * Insert or replace a pending turn-start row.
   *
   * Maintains at most one pending marker per thread.
   */
  readonly upsert: (
    row: ProjectionPendingTurnStart,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a pending turn-start marker by thread id.
   */
  readonly getByThreadId: (
    input: GetProjectionPendingTurnStartInput,
  ) => Effect.Effect<Option.Option<ProjectionPendingTurnStart>, ProjectionRepositoryError>;

  /**
   * Delete a pending turn-start marker by thread id.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionPendingTurnStartInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionPendingTurnStartRepository - Service tag for pending turn-start persistence.
 */
export class ProjectionPendingTurnStartRepository extends ServiceMap.Service<
  ProjectionPendingTurnStartRepository,
  ProjectionPendingTurnStartRepositoryShape
>()("persistence/ProjectionPendingTurnStartRepository") {}
