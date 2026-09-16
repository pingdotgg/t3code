import { OrchestrationCheckpointFile } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  AcknowledgeProjectionPendingTurnStartInput,
  ClearCheckpointTurnConflictInput,
  DeleteProjectionPendingTurnStartInput,
  DeleteProjectionSubmittedTurnStartsByThreadInput,
  DeleteProjectionSubmittedTurnStartsInput,
  DeleteProjectionTurnsAfterCheckpointInput,
  DeleteProjectionTurnsByThreadInput,
  GetProjectionAdoptableTurnStartInput,
  GetProjectionTurnStartByMessageInput,
  GetProjectionPendingTurnStartInput,
  GetProjectionSubmittedTurnStartInput,
  GetProjectionTurnByTurnIdInput,
  ListProjectionTurnsByThreadInput,
  ProjectionPendingTurnStart,
  ProjectionSubmittedTurnStart,
  ProjectionTurn,
  ProjectionTurnById,
  ProjectionTurnRepository,
  type ProjectionTurnRepositoryShape,
} from "../Services/ProjectionTurns.ts";

const ProjectionTurnDbRowSchema = ProjectionTurn.mapFields(
  Struct.assign({
    checkpointFiles: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);

const ProjectionTurnByIdDbRowSchema = ProjectionTurnById.mapFields(
  Struct.assign({
    checkpointFiles: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionTurnRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionTurnById = SqlSchema.void({
    Request: ProjectionTurnByIdDbRowSchema,
    execute: (row) =>
      sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          submitted_turn_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          ${row.threadId},
          ${row.turnId},
          ${row.pendingMessageId},
          NULL,
          ${row.sourceProposedPlanThreadId},
          ${row.sourceProposedPlanId},
          ${row.assistantMessageId},
          ${row.state},
          ${row.requestedAt},
          ${row.startedAt},
          ${row.completedAt},
          ${row.checkpointTurnCount},
          ${row.checkpointRef},
          ${row.checkpointStatus},
          ${row.checkpointFiles}
        )
        ON CONFLICT (thread_id, turn_id)
        DO UPDATE SET
          pending_message_id = excluded.pending_message_id,
          source_proposed_plan_thread_id = excluded.source_proposed_plan_thread_id,
          source_proposed_plan_id = excluded.source_proposed_plan_id,
          assistant_message_id = excluded.assistant_message_id,
          state = excluded.state,
          requested_at = excluded.requested_at,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          checkpoint_turn_count = excluded.checkpoint_turn_count,
          checkpoint_ref = excluded.checkpoint_ref,
          checkpoint_status = excluded.checkpoint_status,
          checkpoint_files_json = excluded.checkpoint_files_json
      `,
  });

  const deletePendingProjectionTurn = SqlSchema.void({
    Request: DeleteProjectionPendingTurnStartInput,
    execute: ({ threadId, messageId, throughRequestSequence }) => {
      // Rows without a stored request sequence predate the column and count as
      // older than every bound.
      const requestBound =
        throughRequestSequence === undefined
          ? sql`1 = 1`
          : sql`(request_sequence IS NULL OR request_sequence <= ${throughRequestSequence})`;
      return sql`
        DELETE FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state IN ('pending', 'submitted')
          AND pending_message_id = ${messageId}
          AND checkpoint_turn_count IS NULL
          AND ${requestBound}
      `;
    },
  });

  const markPendingProjectionTurnSubmitted = SqlSchema.void({
    Request: AcknowledgeProjectionPendingTurnStartInput,
    execute: ({ threadId, messageId, turnId, requestSequence }) => {
      // An acknowledgement answers exactly one request generation. A
      // sequenced acknowledgement prefers the exact row and otherwise falls
      // back to the oldest unsequenced (pre-migration) row; an unsequenced
      // acknowledgement resolves to only the oldest matching generation.
      const requestMatch =
        requestSequence === undefined
          ? sql`row_id = (
              SELECT oldest.row_id
              FROM projection_turns AS oldest
              WHERE oldest.thread_id = ${threadId}
                AND oldest.turn_id IS NULL
                AND oldest.state = 'pending'
                AND oldest.pending_message_id = ${messageId}
                AND oldest.checkpoint_turn_count IS NULL
              ORDER BY oldest.row_id ASC
              LIMIT 1
            )`
          : sql`row_id = (
              SELECT candidate.row_id
              FROM projection_turns AS candidate
              WHERE candidate.thread_id = ${threadId}
                AND candidate.turn_id IS NULL
                AND candidate.state = 'pending'
                AND candidate.pending_message_id = ${messageId}
                AND candidate.checkpoint_turn_count IS NULL
                AND (
                  candidate.request_sequence IS NULL
                  OR candidate.request_sequence = ${requestSequence}
                )
              ORDER BY
                CASE WHEN candidate.request_sequence = ${requestSequence} THEN 0 ELSE 1 END,
                candidate.row_id ASC
              LIMIT 1
            )`;
      // A sequenced acknowledgement that claims a legacy unsequenced row
      // records the generation it answered so later bounds treat the row as
      // that generation rather than "older than everything".
      const sequenceClaim =
        requestSequence === undefined ? sql`` : sql`, request_sequence = ${requestSequence}`;
      return sql`
        UPDATE projection_turns
        SET state = 'submitted', submitted_turn_id = ${turnId}${sequenceClaim}
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'pending'
          AND pending_message_id = ${messageId}
          AND checkpoint_turn_count IS NULL
          AND ${requestMatch}
      `;
    },
  });

  const deleteSubmittedProjectionTurnsByTurn = SqlSchema.void({
    Request: DeleteProjectionSubmittedTurnStartsInput,
    execute: ({ threadId, turnId }) =>
      sql`
        DELETE FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'submitted'
          AND submitted_turn_id = ${turnId}
          AND checkpoint_turn_count IS NULL
      `,
  });

  const deleteSubmittedProjectionTurnsByThread = SqlSchema.void({
    Request: DeleteProjectionSubmittedTurnStartsByThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'submitted'
          AND checkpoint_turn_count IS NULL
      `,
  });

  // A re-dispatched or retried send of the same message reuses its pending
  // placeholder; the row then answers the newest request generation so a clear
  // bounded to an older one cannot retire it. An acknowledged ('submitted')
  // row never blocks the insert — it records a generation the provider already
  // answered, not the still-outstanding send.
  const touchPendingProjectionTurnRequest = SqlSchema.void({
    Request: ProjectionPendingTurnStart,
    execute: (row) =>
      sql`
        UPDATE projection_turns
        SET request_sequence = ${row.requestSequence ?? null}
        WHERE thread_id = ${row.threadId}
          AND turn_id IS NULL
          AND state = 'pending'
          AND pending_message_id = ${row.messageId}
          AND checkpoint_turn_count IS NULL
          AND (request_sequence IS NULL OR request_sequence < ${row.requestSequence ?? 0})
      `,
  });

  const insertPendingProjectionTurn = SqlSchema.void({
    Request: ProjectionPendingTurnStart,
    execute: (row) =>
      sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          submitted_turn_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          request_sequence,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        SELECT
          ${row.threadId},
          NULL,
          ${row.messageId},
          NULL,
          ${row.sourceProposedPlanThreadId},
          ${row.sourceProposedPlanId},
          NULL,
          'pending',
          ${row.requestSequence ?? null},
          ${row.requestedAt},
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          '[]'
        WHERE NOT EXISTS (
          SELECT 1
          FROM projection_turns
          WHERE thread_id = ${row.threadId}
            AND turn_id IS NULL
            AND pending_message_id = ${row.messageId}
            AND state = 'pending'
            AND checkpoint_turn_count IS NULL
        )
      `,
  });

  const insertSubmittedProjectionTurn = SqlSchema.void({
    Request: ProjectionSubmittedTurnStart,
    execute: (row) =>
      sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          submitted_turn_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          request_sequence,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          ${row.threadId},
          NULL,
          ${row.messageId},
          ${row.turnId},
          ${row.sourceProposedPlanThreadId},
          ${row.sourceProposedPlanId},
          NULL,
          'submitted',
          ${row.requestSequence ?? null},
          ${row.requestedAt},
          NULL,
          NULL,
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `,
  });

  const getPendingProjectionTurn = SqlSchema.findOneOption({
    Request: GetProjectionPendingTurnStartInput,
    Result: ProjectionPendingTurnStart,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          pending_message_id AS "messageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          request_sequence AS "requestSequence",
          requested_at AS "requestedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'pending'
          AND pending_message_id IS NOT NULL
          AND checkpoint_turn_count IS NULL
        ORDER BY row_id ASC
        LIMIT 1
      `,
  });

  const getUnresolvedProjectionTurn = SqlSchema.findOneOption({
    Request: GetProjectionPendingTurnStartInput,
    Result: ProjectionPendingTurnStart,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          pending_message_id AS "messageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          requested_at AS "requestedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state IN ('pending', 'submitted')
          AND pending_message_id IS NOT NULL
          AND checkpoint_turn_count IS NULL
        ORDER BY row_id ASC
        LIMIT 1
      `,
  });

  const getAdoptableProjectionTurn = SqlSchema.findOneOption({
    Request: GetProjectionAdoptableTurnStartInput,
    Result: ProjectionPendingTurnStart,
    execute: ({ threadId, turnId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          pending_message_id AS "messageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          candidate.request_sequence AS "requestSequence",
          requested_at AS "requestedAt"
        FROM projection_turns AS candidate
        WHERE candidate.thread_id = ${threadId}
          AND candidate.turn_id IS NULL
          AND (
            (candidate.state = 'submitted' AND candidate.submitted_turn_id = ${turnId})
            OR (
              candidate.state = 'pending'
              AND (
                SELECT COUNT(*)
                FROM projection_turns AS pending
                WHERE pending.thread_id = ${threadId}
                  AND pending.turn_id IS NULL
                  AND pending.state = 'pending'
                  AND pending.pending_message_id IS NOT NULL
                  AND pending.checkpoint_turn_count IS NULL
              ) = 1
            )
          )
          AND candidate.pending_message_id IS NOT NULL
          AND candidate.checkpoint_turn_count IS NULL
        ORDER BY
          CASE
            WHEN candidate.state = 'submitted' AND candidate.submitted_turn_id = ${turnId} THEN 0
            ELSE 1
          END,
          candidate.row_id ASC
        LIMIT 1
      `,
  });

  const getProjectionTurnStartByMessage = SqlSchema.findOneOption({
    Request: GetProjectionTurnStartByMessageInput,
    Result: ProjectionPendingTurnStart,
    execute: ({ threadId, messageId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          pending_message_id AS "messageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          request_sequence AS "requestSequence",
          requested_at AS "requestedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state IN ('pending', 'submitted')
          AND pending_message_id = ${messageId}
          AND checkpoint_turn_count IS NULL
        ORDER BY row_id ASC
        LIMIT 1
      `,
  });

  const getSubmittedProjectionTurn = SqlSchema.findOneOption({
    Request: GetProjectionSubmittedTurnStartInput,
    Result: ProjectionPendingTurnStart,
    execute: ({ threadId, turnId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          pending_message_id AS "messageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          request_sequence AS "requestSequence",
          requested_at AS "requestedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NULL
          AND state = 'submitted'
          AND submitted_turn_id = ${turnId}
          AND pending_message_id IS NOT NULL
          AND checkpoint_turn_count IS NULL
        ORDER BY row_id ASC
        LIMIT 1
      `,
  });

  const listProjectionTurnsByThread = SqlSchema.findAll({
    Request: ListProjectionTurnsByThreadInput,
    Result: ProjectionTurnDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          submitted_turn_id AS "submittedTurnId",
          pending_message_id AS "pendingMessageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          assistant_message_id AS "assistantMessageId",
          state,
          requested_at AS "requestedAt",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "checkpointStatus",
          checkpoint_files_json AS "checkpointFiles"
        FROM projection_turns
        WHERE thread_id = ${threadId}
        ORDER BY
          CASE
            WHEN checkpoint_turn_count IS NULL THEN 1
            ELSE 0
          END ASC,
          checkpoint_turn_count ASC,
          requested_at ASC,
          turn_id ASC
      `,
  });

  const getProjectionTurnByTurnId = SqlSchema.findOneOption({
    Request: GetProjectionTurnByTurnIdInput,
    Result: ProjectionTurnByIdDbRowSchema,
    execute: ({ threadId, turnId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          pending_message_id AS "pendingMessageId",
          source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          source_proposed_plan_id AS "sourceProposedPlanId",
          assistant_message_id AS "assistantMessageId",
          state,
          requested_at AS "requestedAt",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "checkpointStatus",
          checkpoint_files_json AS "checkpointFiles"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id = ${turnId}
        LIMIT 1
      `,
  });

  const clearCheckpointTurnConflictRow = SqlSchema.void({
    Request: ClearCheckpointTurnConflictInput,
    execute: ({ threadId, turnId, checkpointTurnCount }) =>
      sql`
        UPDATE projection_turns
        SET
          checkpoint_turn_count = NULL,
          checkpoint_ref = NULL,
          checkpoint_status = NULL,
          checkpoint_files_json = '[]'
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count = ${checkpointTurnCount}
          AND (turn_id IS NULL OR turn_id <> ${turnId})
      `,
  });

  const deleteProjectionTurnsByThread = SqlSchema.void({
    Request: DeleteProjectionTurnsByThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_turns
        WHERE thread_id = ${threadId}
      `,
  });

  const deleteProjectionTurnsAfterCheckpoint = SqlSchema.void({
    Request: DeleteProjectionTurnsAfterCheckpointInput,
    execute: ({ threadId, turnCount }) =>
      sql`
        DELETE FROM projection_turns
        WHERE thread_id = ${threadId}
          AND turn_id IS NOT NULL
          AND (
            checkpoint_turn_count IS NULL
            OR checkpoint_turn_count > ${turnCount}
          )
      `,
  });

  const upsertByTurnId: ProjectionTurnRepositoryShape["upsertByTurnId"] = (row) =>
    upsertProjectionTurnById(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.upsertByTurnId:query",
          "ProjectionTurnRepository.upsertByTurnId:encodeRequest",
        ),
      ),
    );

  const insertPendingTurnStart: ProjectionTurnRepositoryShape["insertPendingTurnStart"] = (row) =>
    touchPendingProjectionTurnRequest(row).pipe(
      Effect.flatMap(() => insertPendingProjectionTurn(row)),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.insertPendingTurnStart:query",
          "ProjectionTurnRepository.insertPendingTurnStart:encodeRequest",
        ),
      ),
    );

  const insertSubmittedTurnStart: ProjectionTurnRepositoryShape["insertSubmittedTurnStart"] = (
    row,
  ) =>
    insertSubmittedProjectionTurn(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.insertSubmittedTurnStart:query",
          "ProjectionTurnRepository.insertSubmittedTurnStart:encodeRequest",
        ),
      ),
    );

  const markPendingTurnStartSubmitted: ProjectionTurnRepositoryShape["markPendingTurnStartSubmitted"] =
    (input) =>
      markPendingProjectionTurnSubmitted(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionTurnRepository.markPendingTurnStartSubmitted:query"),
        ),
      );

  const deleteSubmittedTurnStartsByTurnId: ProjectionTurnRepositoryShape["deleteSubmittedTurnStartsByTurnId"] =
    (input) =>
      deleteSubmittedProjectionTurnsByTurn(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionTurnRepository.deleteSubmittedTurnStartsByTurnId:query"),
        ),
      );

  const deleteSubmittedTurnStartsByThreadId: ProjectionTurnRepositoryShape["deleteSubmittedTurnStartsByThreadId"] =
    (input) =>
      deleteSubmittedProjectionTurnsByThread(input).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionTurnRepository.deleteSubmittedTurnStartsByThreadId:query",
          ),
        ),
      );

  const getPendingTurnStartByThreadId: ProjectionTurnRepositoryShape["getPendingTurnStartByThreadId"] =
    (input) =>
      getPendingProjectionTurn(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionTurnRepository.getPendingTurnStartByThreadId:query"),
        ),
      );

  const getUnresolvedTurnStartByThreadId: ProjectionTurnRepositoryShape["getUnresolvedTurnStartByThreadId"] =
    (input) =>
      getUnresolvedProjectionTurn(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionTurnRepository.getUnresolvedTurnStartByThreadId:query"),
        ),
      );

  const getAdoptableTurnStartByThreadId: ProjectionTurnRepositoryShape["getAdoptableTurnStartByThreadId"] =
    (input) =>
      getAdoptableProjectionTurn(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionTurnRepository.getAdoptableTurnStartByThreadId:query"),
        ),
      );

  const getTurnStartByMessageId: ProjectionTurnRepositoryShape["getTurnStartByMessageId"] = (
    input,
  ) =>
    getProjectionTurnStartByMessage(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionTurnRepository.getTurnStartByMessageId:query"),
      ),
    );

  const getSubmittedTurnStartByTurnId: ProjectionTurnRepositoryShape["getSubmittedTurnStartByTurnId"] =
    (input) =>
      getSubmittedProjectionTurn(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionTurnRepository.getSubmittedTurnStartByTurnId:query"),
        ),
      );

  const deletePendingTurnStart: ProjectionTurnRepositoryShape["deletePendingTurnStart"] = (input) =>
    deletePendingProjectionTurn(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionTurnRepository.deletePendingTurnStart:query"),
      ),
    );

  const listByThreadId: ProjectionTurnRepositoryShape["listByThreadId"] = (input) =>
    listProjectionTurnsByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.listByThreadId:query",
          "ProjectionTurnRepository.listByThreadId:decodeRows",
        ),
      ),
      Effect.map((rows) => rows as ReadonlyArray<Schema.Schema.Type<typeof ProjectionTurn>>),
    );

  const getByTurnId: ProjectionTurnRepositoryShape["getByTurnId"] = (input) =>
    getProjectionTurnByTurnId(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnRepository.getByTurnId:query",
          "ProjectionTurnRepository.getByTurnId:decodeRow",
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            Effect.succeed(Option.some(row as Schema.Schema.Type<typeof ProjectionTurnById>)),
        }),
      ),
    );

  const clearCheckpointTurnConflict: ProjectionTurnRepositoryShape["clearCheckpointTurnConflict"] =
    (input) =>
      clearCheckpointTurnConflictRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionTurnRepository.clearCheckpointTurnConflict:query"),
        ),
      );

  const deleteByThreadId: ProjectionTurnRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionTurnsByThread(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionTurnRepository.deleteByThreadId:query")),
    );

  const deleteTurnsAfterCheckpoint: ProjectionTurnRepositoryShape["deleteTurnsAfterCheckpoint"] = (
    input,
  ) =>
    deleteProjectionTurnsAfterCheckpoint(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionTurnRepository.deleteTurnsAfterCheckpoint:query"),
      ),
    );

  return {
    upsertByTurnId,
    insertPendingTurnStart,
    insertSubmittedTurnStart,
    markPendingTurnStartSubmitted,
    deleteSubmittedTurnStartsByTurnId,
    deleteSubmittedTurnStartsByThreadId,
    getPendingTurnStartByThreadId,
    getUnresolvedTurnStartByThreadId,
    getAdoptableTurnStartByThreadId,
    getTurnStartByMessageId,
    getSubmittedTurnStartByTurnId,
    deletePendingTurnStart,
    deleteTurnsAfterCheckpoint,
    listByThreadId,
    getByTurnId,
    clearCheckpointTurnConflict,
    deleteByThreadId,
  } satisfies ProjectionTurnRepositoryShape;
});

export const ProjectionTurnRepositoryLive = Layer.effect(
  ProjectionTurnRepository,
  makeProjectionTurnRepository,
);
