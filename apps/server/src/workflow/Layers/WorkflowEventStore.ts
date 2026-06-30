import { WorkflowEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { WorkflowEventStoreError } from "../Services/Errors.ts";
import {
  WorkflowEventStore,
  type PersistedWorkflowEvent,
  type WorkflowEventStoreShape,
} from "../Services/WorkflowEventStore.ts";

interface Row {
  readonly sequence: number;
  readonly eventId: string;
  readonly ticketId: string;
  readonly streamVersion: number;
  readonly type: string;
  readonly occurredAt: string;
  readonly payloadJson: string;
}

const decodePayloadJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeWorkflowEvent = Schema.decodeUnknownEffect(WorkflowEvent);
const encodePayloadJson = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);

const toStoreError = (message: string) => (cause: unknown) =>
  new WorkflowEventStoreError({ message, cause });

const decodeEvent = (row: Row): Effect.Effect<PersistedWorkflowEvent, WorkflowEventStoreError> =>
  Effect.gen(function* () {
    const payload = yield* decodePayloadJson(row.payloadJson);
    const event = yield* decodeWorkflowEvent({
      type: row.type,
      eventId: row.eventId,
      ticketId: row.ticketId,
      streamVersion: row.streamVersion,
      occurredAt: row.occurredAt,
      payload,
    });
    return { ...event, sequence: row.sequence } as PersistedWorkflowEvent;
  }).pipe(Effect.mapError(toStoreError("Failed to decode workflow event")));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // INVARIANT: append derives the next stream_version with an inline
  // `SELECT MAX(stream_version)+1` subquery and has NO retry on the
  // (ticket_id, stream_version) UNIQUE index (idx_workflow_events_stream_version,
  // migration 033). It is therefore NOT internally safe against concurrent
  // appends for the same ticket — callers MUST serialize per-ticket appends
  // through that ticket's board save lock (every commit/commitMany path in
  // WorkflowEventCommitter does so via saveLocks.withSaveLock /
  // withBoardSaveLock). Two unserialized appenders would read the same MAX,
  // both compute version N+1, and one INSERT would violate the UNIQUE index,
  // surfacing as a generic "append failed" rather than an optimistic-concurrency
  // retry. Any new append path must hold the board save lock (or this must be
  // reworked into an explicit retry-on-conflict loop).
  const append: WorkflowEventStoreShape["append"] = (event) =>
    Effect.gen(function* () {
      const payloadJson = yield* encodePayloadJson(event.payload);
      const rows = yield* sql<Row>`
        INSERT INTO workflow_events
          (event_id, ticket_id, stream_version, event_type, occurred_at, payload_json)
        VALUES (
          ${event.eventId},
          ${event.ticketId},
          COALESCE(
            (
              SELECT stream_version + 1
              FROM workflow_events
              WHERE ticket_id = ${event.ticketId}
              ORDER BY stream_version DESC
              LIMIT 1
            ),
            0
          ),
          ${event.type},
          ${event.occurredAt},
          ${payloadJson}
        )
        RETURNING
          sequence,
          event_id AS "eventId",
          ticket_id AS "ticketId",
          stream_version AS "streamVersion",
          event_type AS "type",
          occurred_at AS "occurredAt",
          payload_json AS "payloadJson"
      `;
      const row = rows[0];
      if (!row) {
        return yield* new WorkflowEventStoreError({ message: "append returned no row" });
      }
      return yield* decodeEvent(row);
    }).pipe(Effect.mapError(toStoreError("append failed")));

  const streamRows = (
    query: Effect.Effect<ReadonlyArray<Row>, SqlError>,
  ): Stream.Stream<PersistedWorkflowEvent, WorkflowEventStoreError> =>
    Stream.fromEffect(query.pipe(Effect.mapError(toStoreError("read failed")))).pipe(
      Stream.flatMap((rows) => Stream.fromIterable(rows)),
      Stream.mapEffect(decodeEvent),
    );

  const readByTicket: WorkflowEventStoreShape["readByTicket"] = (ticketId) =>
    streamRows(sql<Row>`
      SELECT
        sequence,
        event_id AS "eventId",
        ticket_id AS "ticketId",
        stream_version AS "streamVersion",
        event_type AS "type",
        occurred_at AS "occurredAt",
        payload_json AS "payloadJson"
      FROM workflow_events
      WHERE ticket_id = ${ticketId}
      ORDER BY stream_version ASC
    `);

  const readFromSequence: WorkflowEventStoreShape["readFromSequence"] = (
    sequenceExclusive,
    limit = 1_000,
  ) => {
    const normalizedLimit = Math.max(0, Math.floor(limit));
    if (normalizedLimit === 0) {
      return Stream.empty;
    }
    return streamRows(sql<Row>`
      SELECT
        sequence,
        event_id AS "eventId",
        ticket_id AS "ticketId",
        stream_version AS "streamVersion",
        event_type AS "type",
        occurred_at AS "occurredAt",
        payload_json AS "payloadJson"
      FROM workflow_events
      WHERE sequence > ${sequenceExclusive}
      ORDER BY sequence ASC
      LIMIT ${normalizedLimit}
    `);
  };

  const readAll: WorkflowEventStoreShape["readAll"] = () =>
    readFromSequence(0, Number.MAX_SAFE_INTEGER);

  const deleteForBoard: WorkflowEventStoreShape["deleteForBoard"] = (boardId) =>
    sql`
      DELETE FROM workflow_events
      WHERE ticket_id IN (
        SELECT ticket_id
        FROM projection_ticket
        WHERE board_id = ${boardId}
      )
    `.pipe(Effect.mapError(toStoreError("delete failed")), Effect.asVoid);

  const deleteForTicket: WorkflowEventStoreShape["deleteForTicket"] = (ticketId) =>
    sql`
      DELETE FROM workflow_events
      WHERE ticket_id = ${ticketId}
    `.pipe(Effect.mapError(toStoreError("delete failed")), Effect.asVoid);

  return {
    append,
    readByTicket,
    readFromSequence,
    readAll,
    deleteForBoard,
    deleteForTicket,
  } satisfies WorkflowEventStoreShape;
});

export const WorkflowEventStoreLive = Layer.effect(WorkflowEventStore, make);
