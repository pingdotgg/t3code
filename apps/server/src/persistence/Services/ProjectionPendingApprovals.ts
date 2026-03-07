/**
 * ProjectionPendingApprovalRepository - Repository interface for pending approvals.
 *
 * Owns persistence operations for projected approval requests awaiting user
 * decisions.
 *
 * @module ProjectionPendingApprovalRepository
 */
import {
  ApprovalRequestId,
  IsoDateTime,
  ProjectionPendingApprovalDecision,
  ProjectionPendingApprovalStatus,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionPendingApproval = Schema.Struct({
  requestId: ApprovalRequestId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  status: ProjectionPendingApprovalStatus,
  decision: ProjectionPendingApprovalDecision,
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionPendingApproval = typeof ProjectionPendingApproval.Type;

export const ListProjectionPendingApprovalsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionPendingApprovalsInput = typeof ListProjectionPendingApprovalsInput.Type;

export const GetProjectionPendingApprovalInput = Schema.Struct({
  requestId: ApprovalRequestId,
});
export type GetProjectionPendingApprovalInput = typeof GetProjectionPendingApprovalInput.Type;

export const DeleteProjectionPendingApprovalInput = Schema.Struct({
  requestId: ApprovalRequestId,
});
export type DeleteProjectionPendingApprovalInput = typeof DeleteProjectionPendingApprovalInput.Type;

/**
 * ProjectionPendingApprovalRepositoryShape - Service API for pending approvals.
 */
export interface ProjectionPendingApprovalRepositoryShape {
  /**
   * Insert or replace a projected pending approval row.
   *
   * Upserts by `requestId`.
   */
  readonly upsert: (
    row: ProjectionPendingApproval,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * List pending approvals for a thread.
   *
   * Returned in ascending creation order.
   */
  readonly listByThreadId: (
    input: ListProjectionPendingApprovalsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionPendingApproval>, ProjectionRepositoryError>;

  /**
   * Read a pending approval row by request id.
   */
  readonly getByRequestId: (
    input: GetProjectionPendingApprovalInput,
  ) => Effect.Effect<Option.Option<ProjectionPendingApproval>, ProjectionRepositoryError>;

  /**
   * Delete a pending approval row by request id.
   */
  readonly deleteByRequestId: (
    input: DeleteProjectionPendingApprovalInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionPendingApprovalRepository - Service tag for pending approval persistence.
 */
export class ProjectionPendingApprovalRepository extends ServiceMap.Service<
  ProjectionPendingApprovalRepository,
  ProjectionPendingApprovalRepositoryShape
>()("t3/persistence/Services/ProjectionPendingApprovals/ProjectionPendingApprovalRepository") {}
