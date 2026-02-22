import fs from "node:fs";
import path from "node:path";

import type { OrchestrationEvent } from "@t3tools/contracts";
import { OrchestrationEventSchema } from "@t3tools/contracts";
import type { SqlClient as SqlClientService } from "@effect/sql/SqlClient";
import * as SqlClient from "@effect/sql/SqlClient";
import * as SqlSchema from "@effect/sql/SqlSchema";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { Effect, ManagedRuntime, Schema } from "effect";

import type { OrchestrationEventRepositoryShape } from "./eventRepository";
import { runOrchestrationMigrations } from "./migrations";

const decodeEvent = Schema.decodeUnknownSync(OrchestrationEventSchema);

const EventRowSchema = Schema.Struct({
  sequence: Schema.Number,
  eventId: Schema.String,
  type: Schema.String,
  aggregateType: Schema.String,
  aggregateId: Schema.String,
  occurredAt: Schema.String,
  commandId: Schema.NullOr(Schema.String),
  payloadJson: Schema.String,
});

type EventRow = Schema.Schema.Type<typeof EventRowSchema>;

const AppendEventRequestSchema = Schema.Struct({
  eventId: Schema.String,
  type: Schema.String,
  aggregateType: Schema.String,
  aggregateId: Schema.String,
  occurredAt: Schema.String,
  commandId: Schema.NullOr(Schema.String),
  payloadJson: Schema.String,
});

const ReadFromSequenceRequestSchema = Schema.Struct({
  sequenceExclusive: Schema.Number,
  limit: Schema.Number,
});

const appendEventRow = SqlSchema.single({
  Request: AppendEventRequestSchema,
  Result: EventRowSchema,
  execute: (request) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`
        INSERT INTO orchestration_events (
          event_id,
          event_type,
          aggregate_type,
          aggregate_id,
          occurred_at,
          command_id,
          payload_json
        )
        VALUES (
          ${request.eventId},
          ${request.type},
          ${request.aggregateType},
          ${request.aggregateId},
          ${request.occurredAt},
          ${request.commandId},
          ${request.payloadJson}
        )
        RETURNING
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_type AS "aggregateType",
          aggregate_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          payload_json AS "payloadJson"
      `,
    ),
});

const readEventRowsFromSequence = SqlSchema.findAll({
  Request: ReadFromSequenceRequestSchema,
  Result: EventRowSchema,
  execute: (request) =>
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql`
        SELECT
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_type AS "aggregateType",
          aggregate_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          payload_json AS "payloadJson"
        FROM orchestration_events
        WHERE sequence > ${request.sequenceExclusive}
        ORDER BY sequence ASC
        LIMIT ${request.limit}
      `,
    ),
});

function eventRowToOrchestrationEvent(row: EventRow): OrchestrationEvent {
  return decodeEvent({
    sequence: row.sequence,
    eventId: row.eventId,
    type: row.type,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    occurredAt: row.occurredAt,
    commandId: row.commandId,
    payload: JSON.parse(row.payloadJson) as unknown,
  });
}

export function makeSqliteOrchestrationEventRepository(
  dbPath: string,
): OrchestrationEventRepositoryShape {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const runtime: ManagedRuntime.ManagedRuntime<SqlClientService, unknown> = ManagedRuntime.make(
    SqliteClient.layer({
      filename: dbPath,
    }),
  );
  let closed = false;

  const provideSql = <A, E>(
    effect: Effect.Effect<A, E, SqlClientService>,
  ): Effect.Effect<A, E | unknown> => Effect.provide(effect, runtime);

  const initialize = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* runOrchestrationMigrations;
  });

  const initialized = runtime.runPromise(initialize).then(() => undefined);
  const ensureInitialized = Effect.promise(() => initialized);

  const append: OrchestrationEventRepositoryShape["append"] = (event) =>
    Effect.gen(function* () {
      yield* ensureInitialized;
      const row = yield* provideSql(
        appendEventRow({
          eventId: event.eventId,
          type: event.type,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          occurredAt: event.occurredAt,
          commandId: event.commandId,
          payloadJson: JSON.stringify(event.payload),
        }),
      );
      return eventRowToOrchestrationEvent(row);
    }).pipe(Effect.orDie);

  const readFromSequence: OrchestrationEventRepositoryShape["readFromSequence"] = (
    sequenceExclusive,
    limit = 1_000,
  ) =>
    Effect.gen(function* () {
      yield* ensureInitialized;
      const rows = yield* provideSql(
        readEventRowsFromSequence({
          sequenceExclusive,
          limit,
        }),
      );
      return rows.map(eventRowToOrchestrationEvent);
    }).pipe(Effect.orDie);

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    void runtime.dispose();
  };

  return {
    append,
    readFromSequence,
    readAll: () => readFromSequence(0, Number.MAX_SAFE_INTEGER),
    close,
  };
}
