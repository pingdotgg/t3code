import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  CompleteNotificationTransportOutcomeInput,
  FindTerminalNotificationInput,
  GetNotificationOutboxRecordInput,
  ListDecidedNotificationEdgesInput,
  ListNotificationOutboxByThreadInput,
  NotificationOutboxRecord,
  NotificationOutboxRepository,
  type NotificationOutboxRepositoryShape,
} from "../Services/NotificationOutbox.ts";

const SELECT_COLUMNS = `
  identity_key AS "identityKey",
  kind,
  thread_id AS "threadId",
  project_id AS "projectId",
  turn_id AS "turnId",
  request_id AS "requestId",
  project_title AS "projectTitle",
  thread_title AS "threadTitle",
  headline,
  detail,
  triggering_event_id AS "triggeringEventId",
  triggering_sequence AS "triggeringSequence",
  previous_phase AS "previousPhase",
  next_phase AS "nextPhase",
  detection_verdict AS "detectionVerdict",
  deciding_guard AS "decidingGuard",
  transport_outcome AS "transportOutcome",
  transport_name AS "transportName",
  detected_at AS "detectedAt",
  completed_at AS "completedAt"
`;

const makeNotificationOutboxRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql.literal(SELECT_COLUMNS);

  const insertNotificationOutboxRow = SqlSchema.void({
    Request: NotificationOutboxRecord,
    execute: (row) =>
      sql`
        INSERT INTO notification_outbox (
          identity_key,
          kind,
          thread_id,
          project_id,
          turn_id,
          request_id,
          project_title,
          thread_title,
          headline,
          detail,
          triggering_event_id,
          triggering_sequence,
          previous_phase,
          next_phase,
          detection_verdict,
          deciding_guard,
          transport_outcome,
          transport_name,
          detected_at,
          completed_at
        )
        VALUES (
          ${row.identityKey},
          ${row.kind},
          ${row.threadId},
          ${row.projectId},
          ${row.turnId},
          ${row.requestId},
          ${row.projectTitle},
          ${row.threadTitle},
          ${row.headline},
          ${row.detail},
          ${row.triggeringEventId},
          ${row.triggeringSequence},
          ${row.previousPhase},
          ${row.nextPhase},
          ${row.detectionVerdict},
          ${row.decidingGuard},
          ${row.transportOutcome},
          ${row.transportName},
          ${row.detectedAt},
          ${row.completedAt}
        )
        ON CONFLICT DO NOTHING
      `,
  });

  const getNotificationOutboxRow = SqlSchema.findOneOption({
    Request: GetNotificationOutboxRecordInput,
    Result: NotificationOutboxRecord,
    execute: ({ identityKey }) =>
      sql`
        SELECT ${columns}
        FROM notification_outbox
        WHERE identity_key = ${identityKey}
      `,
  });

  const findTerminalNotificationRow = SqlSchema.findOneOption({
    Request: FindTerminalNotificationInput,
    Result: NotificationOutboxRecord,
    execute: ({ threadId, turnId }) =>
      sql`
        SELECT ${columns}
        FROM notification_outbox
        WHERE thread_id = ${threadId}
          AND turn_id = ${turnId}
          AND kind IN ('turn-completed', 'turn-failed')
      `,
  });

  const deleteNotificationOutboxRow = SqlSchema.void({
    Request: GetNotificationOutboxRecordInput,
    execute: ({ identityKey }) =>
      sql`
        DELETE FROM notification_outbox
        WHERE identity_key = ${identityKey}
      `,
  });

  const listNotificationOutboxRowsByThread = SqlSchema.findAll({
    Request: ListNotificationOutboxByThreadInput,
    Result: NotificationOutboxRecord,
    execute: ({ threadId }) =>
      sql`
        SELECT ${columns}
        FROM notification_outbox
        WHERE thread_id = ${threadId}
        ORDER BY triggering_sequence ASC, identity_key ASC
      `,
  });

  const listDecidedNotificationEdgeRows = SqlSchema.findAll({
    Request: ListDecidedNotificationEdgesInput,
    Result: NotificationOutboxRecord,
    execute: ({ afterSequence, limit }) =>
      sql`
        SELECT ${columns}
        FROM notification_outbox
        WHERE detection_verdict = 'detected'
          AND triggering_sequence > ${afterSequence}
        ORDER BY triggering_sequence ASC, identity_key ASC
        LIMIT ${limit}
      `,
  });

  const completeNotificationTransportOutcomeRow = SqlSchema.void({
    Request: CompleteNotificationTransportOutcomeInput,
    execute: ({ identityKey, transportOutcome, transportName, completedAt }) =>
      sql`
        UPDATE notification_outbox
        SET transport_outcome = ${transportOutcome},
            transport_name = ${transportName},
            completed_at = ${completedAt}
        WHERE identity_key = ${identityKey}
          AND completed_at IS NULL
      `,
  });

  const insertIfAbsent: NotificationOutboxRepositoryShape["insertIfAbsent"] = (row) =>
    insertNotificationOutboxRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("NotificationOutboxRepository.insertIfAbsent:query")),
    );

  const getByIdentityKey: NotificationOutboxRepositoryShape["getByIdentityKey"] = (input) =>
    getNotificationOutboxRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("NotificationOutboxRepository.getByIdentityKey:query")),
    );

  const findTerminalByThreadTurn: NotificationOutboxRepositoryShape["findTerminalByThreadTurn"] = (
    input,
  ) =>
    findTerminalNotificationRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("NotificationOutboxRepository.findTerminalByThreadTurn:query"),
      ),
    );

  const deleteByIdentityKey: NotificationOutboxRepositoryShape["deleteByIdentityKey"] = (input) =>
    deleteNotificationOutboxRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("NotificationOutboxRepository.deleteByIdentityKey:query"),
      ),
    );

  const listByThreadId: NotificationOutboxRepositoryShape["listByThreadId"] = (input) =>
    listNotificationOutboxRowsByThread(input).pipe(
      Effect.mapError(toPersistenceSqlError("NotificationOutboxRepository.listByThreadId:query")),
    );

  const listDecidedEdgesAfterSequence: NotificationOutboxRepositoryShape["listDecidedEdgesAfterSequence"] =
    (input) =>
      listDecidedNotificationEdgeRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("NotificationOutboxRepository.listDecidedEdgesAfterSequence:query"),
        ),
      );

  const completeTransportOutcome: NotificationOutboxRepositoryShape["completeTransportOutcome"] = (
    input,
  ) =>
    completeNotificationTransportOutcomeRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("NotificationOutboxRepository.completeTransportOutcome:query"),
      ),
    );

  return {
    insertIfAbsent,
    getByIdentityKey,
    deleteByIdentityKey,
    findTerminalByThreadTurn,
    listByThreadId,
    listDecidedEdgesAfterSequence,
    completeTransportOutcome,
  } satisfies NotificationOutboxRepositoryShape;
});

export const NotificationOutboxRepositoryLive = Layer.effect(
  NotificationOutboxRepository,
  makeNotificationOutboxRepository,
);
