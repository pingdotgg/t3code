import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema, Struct } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadInput,
  GetProjectionThreadInput,
  ListProjectionThreadsByProjectInput,
  ProjectionThread,
  ProjectionThreadRepository,
  type ProjectionThreadRepositoryShape,
} from "../Services/ProjectionThreads.ts";
import {
  GitPullRequestAssociation,
  CollaborationRequest,
  ModelSelection,
  PendingPullRequestAssociation,
  ReviewResult,
  ReviewSnapshot,
  ThreadNudging,
  ValidationRequest,
  ValidationRun,
  WorkspaceBinding,
} from "@t3tools/contracts";

const ProjectionThreadDbRow = ProjectionThread.mapFields(
  Struct.assign({
    nudging: Schema.fromJsonString(ThreadNudging),
    collaborationRequests: Schema.fromJsonString(Schema.Array(CollaborationRequest)),
    modelSelection: Schema.fromJsonString(ModelSelection),
    pullRequest: Schema.NullOr(Schema.fromJsonString(Schema.NullOr(GitPullRequestAssociation))),
    reviewSnapshot: Schema.NullOr(Schema.fromJsonString(Schema.NullOr(ReviewSnapshot))),
    reviewResult: Schema.NullOr(Schema.fromJsonString(Schema.NullOr(ReviewResult))),
    validationRequest: Schema.NullOr(Schema.fromJsonString(Schema.NullOr(ValidationRequest))),
    validationRun: Schema.NullOr(Schema.fromJsonString(Schema.NullOr(ValidationRun))),
    workspaceBinding: Schema.NullOr(Schema.fromJsonString(Schema.NullOr(WorkspaceBinding))),
    pendingPullRequestAssociation: Schema.fromJsonString(
      Schema.NullOr(PendingPullRequestAssociation),
    ),
  }),
);
type ProjectionThreadDbRow = typeof ProjectionThreadDbRow.Type;

const makeProjectionThreadRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadRow = SqlSchema.void({
    Request: ProjectionThread,
    execute: (row) =>
      sql`
        INSERT INTO projection_threads (
          nudging_json,
          collaboration_requests_json,
          thread_id,
          project_id,
          parent_thread_id,
          title,
          model_selection_json,
          runtime_mode,
          pending_runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          workspace_binding_json,
          pull_request_json,
          pending_pull_request_association_json,
          review_snapshot_json,
          review_result_json,
          validation_request_json,
          validation_run_json,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          snoozed_until,
          snoozed_at,
          pinned_at,
          pin_order_key,
          title_regeneration_request_id,
          title_regeneration_started_at,
          latest_user_message_at,
          latest_child_notification_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at
        )
        VALUES (
          ${JSON.stringify(row.nudging ?? {})},
          ${JSON.stringify(row.collaborationRequests ?? [])},
          ${row.threadId},
          ${row.projectId},
          ${row.parentThreadId ?? null},
          ${row.title},
          ${JSON.stringify(row.modelSelection)},
          ${row.runtimeMode},
          ${row.pendingRuntimeMode},
          ${row.interactionMode},
          ${row.branch},
          ${row.worktreePath},
          ${JSON.stringify(row.workspaceBinding ?? null)},
          ${JSON.stringify(row.pullRequest ?? null)},
          ${JSON.stringify(row.pendingPullRequestAssociation ?? null)},
          ${JSON.stringify(row.reviewSnapshot ?? null)},
          ${JSON.stringify(row.reviewResult ?? null)},
          ${JSON.stringify(row.validationRequest ?? null)},
          ${JSON.stringify(row.validationRun ?? null)},
          ${row.latestTurnId},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.archivedAt},
          ${row.settledOverride},
          ${row.settledAt},
          ${row.snoozedUntil},
          ${row.snoozedAt},
          ${row.pinnedAt},
          ${row.pinOrderKey},
          ${row.titleRegenerationRequestId ?? null},
          ${row.titleRegenerationStartedAt ?? null},
          ${row.latestUserMessageAt},
          ${row.latestChildNotificationAt},
          ${row.pendingApprovalCount},
          ${row.pendingUserInputCount},
          ${row.hasActionableProposedPlan},
          ${row.deletedAt}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          nudging_json = excluded.nudging_json,
          collaboration_requests_json = excluded.collaboration_requests_json,
          project_id = excluded.project_id,
          parent_thread_id = excluded.parent_thread_id,
          title = excluded.title,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          pending_runtime_mode = excluded.pending_runtime_mode,
          interaction_mode = excluded.interaction_mode,
          branch = excluded.branch,
          worktree_path = excluded.worktree_path,
          workspace_binding_json = excluded.workspace_binding_json,
          pull_request_json = excluded.pull_request_json,
          pending_pull_request_association_json = excluded.pending_pull_request_association_json,
          review_snapshot_json = excluded.review_snapshot_json,
          review_result_json = excluded.review_result_json,
          validation_request_json = excluded.validation_request_json,
          validation_run_json = excluded.validation_run_json,
          latest_turn_id = excluded.latest_turn_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          archived_at = excluded.archived_at,
          settled_override = excluded.settled_override,
          settled_at = excluded.settled_at,
          snoozed_until = excluded.snoozed_until,
          snoozed_at = excluded.snoozed_at,
          pinned_at = excluded.pinned_at,
          pin_order_key = excluded.pin_order_key,
          title_regeneration_request_id = excluded.title_regeneration_request_id,
          title_regeneration_started_at = excluded.title_regeneration_started_at,
          latest_user_message_at = excluded.latest_user_message_at,
          latest_child_notification_at = excluded.latest_child_notification_at,
          pending_approval_count = excluded.pending_approval_count,
          pending_user_input_count = excluded.pending_user_input_count,
          has_actionable_proposed_plan = excluded.has_actionable_proposed_plan,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionThreadRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadInput,
    Result: ProjectionThreadDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          nudging_json AS "nudging",
          collaboration_requests_json AS "collaborationRequests",
          thread_id AS "threadId",
          project_id AS "projectId",
          parent_thread_id AS "parentThreadId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          pending_runtime_mode AS "pendingRuntimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          workspace_binding_json AS "workspaceBinding",
          pull_request_json AS "pullRequest",
          pending_pull_request_association_json AS "pendingPullRequestAssociation",
          review_snapshot_json AS "reviewSnapshot",
          review_result_json AS "reviewResult",
          validation_request_json AS "validationRequest",
          validation_run_json AS "validationRun",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          pinned_at AS "pinnedAt",
          pin_order_key AS "pinOrderKey",
          title_regeneration_request_id AS "titleRegenerationRequestId",
          title_regeneration_started_at AS "titleRegenerationStartedAt",
          latest_user_message_at AS "latestUserMessageAt",
          latest_child_notification_at AS "latestChildNotificationAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const listProjectionThreadRows = SqlSchema.findAll({
    Request: ListProjectionThreadsByProjectInput,
    Result: ProjectionThreadDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          nudging_json AS "nudging",
          collaboration_requests_json AS "collaborationRequests",
          thread_id AS "threadId",
          project_id AS "projectId",
          parent_thread_id AS "parentThreadId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          pending_runtime_mode AS "pendingRuntimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          workspace_binding_json AS "workspaceBinding",
          pull_request_json AS "pullRequest",
          pending_pull_request_association_json AS "pendingPullRequestAssociation",
          review_snapshot_json AS "reviewSnapshot",
          review_result_json AS "reviewResult",
          validation_request_json AS "validationRequest",
          validation_run_json AS "validationRun",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          pinned_at AS "pinnedAt",
          pin_order_key AS "pinOrderKey",
          title_regeneration_request_id AS "titleRegenerationRequestId",
          title_regeneration_started_at AS "titleRegenerationStartedAt",
          latest_user_message_at AS "latestUserMessageAt",
          latest_child_notification_at AS "latestChildNotificationAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE project_id = ${projectId}
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const deleteProjectionThreadRow = SqlSchema.void({
    Request: DeleteProjectionThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.upsert:query")),
    );

  const getById: ProjectionThreadRepositoryShape["getById"] = (input) =>
    getProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.getById:query")),
    );

  const listByProjectId: ProjectionThreadRepositoryShape["listByProjectId"] = (input) =>
    listProjectionThreadRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.listByProjectId:query")),
    );

  const deleteById: ProjectionThreadRepositoryShape["deleteById"] = (input) =>
    deleteProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.deleteById:query")),
    );

  return {
    upsert,
    getById,
    listByProjectId,
    deleteById,
  } satisfies ProjectionThreadRepositoryShape;
});

export const ProjectionThreadRepositoryLive = Layer.effect(
  ProjectionThreadRepository,
  makeProjectionThreadRepository,
);
