import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionPendingApprovalInput,
  DeleteProjectionPendingApprovalInput,
  ListProjectionPendingApprovalsInput,
  ProjectionPendingApproval,
  ProjectionPendingApprovalRepository,
  type ProjectionPendingApprovalRepositoryShape,
} from "../Services/ProjectionPendingApprovals.ts";

const makeProjectionPendingApprovalRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionPendingApprovalRow = SqlSchema.void({
    Request: ProjectionPendingApproval,
    execute: (row) =>
      sql`
        INSERT INTO projection_pending_approvals (
          request_id,
          thread_id,
          turn_id,
          status,
          decision,
          created_at,
          resolved_at
        )
        VALUES (
          ${row.requestId},
          ${row.threadId},
          ${row.turnId},
          ${row.status},
          ${row.decision},
          ${row.createdAt},
          ${row.resolvedAt}
        )
        ON CONFLICT (request_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          status = excluded.status,
          decision = excluded.decision,
          created_at = excluded.created_at,
          resolved_at = excluded.resolved_at
      `,
  });

  const listProjectionPendingApprovalRows = SqlSchema.findAll({
    Request: ListProjectionPendingApprovalsInput,
    Result: ProjectionPendingApproval,
    execute: ({ threadId }) =>
      sql`
        SELECT
          request_id AS "requestId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          status,
          decision,
          created_at AS "createdAt",
          resolved_at AS "resolvedAt"
        FROM projection_pending_approvals
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, request_id ASC
      `,
  });

  const getProjectionPendingApprovalRow = SqlSchema.findOneOption({
    Request: GetProjectionPendingApprovalInput,
    Result: ProjectionPendingApproval,
    execute: ({ requestId }) =>
      sql`
        SELECT
          request_id AS "requestId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          status,
          decision,
          created_at AS "createdAt",
          resolved_at AS "resolvedAt"
        FROM projection_pending_approvals
        WHERE request_id = ${requestId}
      `,
  });

  const deleteProjectionPendingApprovalRow = SqlSchema.void({
    Request: DeleteProjectionPendingApprovalInput,
    execute: ({ requestId }) =>
      sql`
        DELETE FROM projection_pending_approvals
        WHERE request_id = ${requestId}
      `,
  });

  const upsert: ProjectionPendingApprovalRepositoryShape["upsert"] = (row) =>
    upsertProjectionPendingApprovalRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionPendingApprovalRepository.upsert:query")),
    );

  const listByThreadId: ProjectionPendingApprovalRepositoryShape["listByThreadId"] = (input) =>
    listProjectionPendingApprovalRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionPendingApprovalRepository.listByThreadId:query"),
      ),
    );

  const getByRequestId: ProjectionPendingApprovalRepositoryShape["getByRequestId"] = (input) =>
    getProjectionPendingApprovalRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionPendingApprovalRepository.getByRequestId:query"),
      ),
    );

  const deleteByRequestId: ProjectionPendingApprovalRepositoryShape["deleteByRequestId"] = (
    input,
  ) =>
    deleteProjectionPendingApprovalRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionPendingApprovalRepository.deleteByRequestId:query"),
      ),
    );

  return {
    upsert,
    listByThreadId,
    getByRequestId,
    deleteByRequestId,
  } satisfies ProjectionPendingApprovalRepositoryShape;
});

export const ProjectionPendingApprovalRepositoryLive = Layer.effect(
  ProjectionPendingApprovalRepository,
  makeProjectionPendingApprovalRepository,
);
