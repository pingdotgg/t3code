/**
 * ProjectionThreadSessionRepository - Repository interface for thread sessions.
 *
 * Owns persistence operations for projected provider-session linkage and
 * runtime status for each thread.
 *
 * @module ProjectionThreadSessionRepository
 */
import {
  IsoDateTime,
  OrchestrationSessionStatus,
  ProviderSessionId,
  ProviderThreadId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadSession = Schema.Struct({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(Schema.String),
  providerSessionId: Schema.NullOr(ProviderSessionId),
  providerThreadId: Schema.NullOr(ProviderThreadId),
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type ProjectionThreadSession = typeof ProjectionThreadSession.Type;

export const GetProjectionThreadSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionThreadSessionInput = typeof GetProjectionThreadSessionInput.Type;

export const DeleteProjectionThreadSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadSessionInput = typeof DeleteProjectionThreadSessionInput.Type;

/**
 * ProjectionThreadSessionRepositoryShape - Service API for projected thread sessions.
 */
export interface ProjectionThreadSessionRepositoryShape {
  /**
   * Insert or replace a projected thread-session row.
   *
   * Upserts by `threadId`.
   */
  readonly upsert: (row: ProjectionThreadSession) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read projected thread-session state by thread id.
   */
  readonly getByThreadId: (
    input: GetProjectionThreadSessionInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadSession>, ProjectionRepositoryError>;

  /**
   * Delete projected thread-session state by thread id.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadSessionInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadSessionRepository - Service tag for thread-session persistence.
 */
export class ProjectionThreadSessionRepository extends ServiceMap.Service<
  ProjectionThreadSessionRepository,
  ProjectionThreadSessionRepositoryShape
>()("t3/persistence/Services/ProjectionThreadSessions/ProjectionThreadSessionRepository") {}
