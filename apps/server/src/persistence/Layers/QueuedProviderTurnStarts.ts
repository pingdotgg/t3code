import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  QueuedProviderTurnStart,
  QueuedProviderTurnStartRepository,
  QueuedProviderTurnStartSequence,
  type QueuedProviderTurnStartRepositoryShape,
} from "../Services/QueuedProviderTurnStarts.ts";
import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";

function mapError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const enqueueRow = SqlSchema.void({
    Request: QueuedProviderTurnStart,
    execute: (row) =>
      sql`
        INSERT INTO queued_provider_turn_starts (
          event_sequence,
          thread_id,
          message_id
        )
        VALUES (
          ${row.eventSequence},
          ${row.threadId},
          ${row.messageId}
        )
        ON CONFLICT (event_sequence) DO NOTHING
      `,
  });
  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: QueuedProviderTurnStart,
    execute: () =>
      sql`
        SELECT
          event_sequence AS "eventSequence",
          thread_id AS "threadId",
          message_id AS "messageId"
        FROM queued_provider_turn_starts
        ORDER BY event_sequence ASC
      `,
  });
  const deleteRow = SqlSchema.void({
    Request: QueuedProviderTurnStartSequence,
    execute: ({ eventSequence }) =>
      sql`
        DELETE FROM queued_provider_turn_starts
        WHERE event_sequence = ${eventSequence}
      `,
  });

  return {
    enqueue: (row) =>
      enqueueRow(row).pipe(
        Effect.mapError(
          mapError(
            "QueuedProviderTurnStartRepository.enqueue:query",
            "QueuedProviderTurnStartRepository.enqueue:encode",
          ),
        ),
      ),
    list: () =>
      listRows().pipe(
        Effect.mapError(
          mapError(
            "QueuedProviderTurnStartRepository.list:query",
            "QueuedProviderTurnStartRepository.list:decode",
          ),
        ),
      ),
    delete: (input) =>
      deleteRow(input).pipe(
        Effect.mapError(
          mapError(
            "QueuedProviderTurnStartRepository.delete:query",
            "QueuedProviderTurnStartRepository.delete:encode",
          ),
        ),
      ),
  } satisfies QueuedProviderTurnStartRepositoryShape;
});

export const QueuedProviderTurnStartRepositoryLive = Layer.effect(
  QueuedProviderTurnStartRepository,
  make,
);
