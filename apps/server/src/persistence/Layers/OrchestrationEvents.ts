import fs from "node:fs";
import path from "node:path";

import type { OrchestrationEvent } from "@t3tools/contracts";
import { OrchestrationEventSchema } from "@t3tools/contracts";
import type { SqlClient as SqlClientService } from "@effect/sql/SqlClient";
import * as SqlClient from "@effect/sql/SqlClient";
import * as SqlSchema from "@effect/sql/SqlSchema";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { Context, Effect, Layer, Schema } from "effect";

import { runMigrations } from "../Migrations";
import {
  OrchestrationEventRepository,
  type OrchestrationEventRepositoryShape,
} from "../Services/OrchestrationEvents";

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

class OrchestrationSql extends Context.Tag("persistence/OrchestrationSql")<
  OrchestrationSql,
  SqlClientService
>() {}

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

const makeRepository = Effect.gen(function* () {
  const sql = yield* OrchestrationSql;

  const appendEventRow = SqlSchema.single({
    Request: AppendEventRequestSchema,
    Result: EventRowSchema,
    execute: (request) =>
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
  });

  const readEventRowsFromSequence = SqlSchema.findAll({
    Request: ReadFromSequenceRequestSchema,
    Result: EventRowSchema,
    execute: (request) =>
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
  });

  const append: OrchestrationEventRepositoryShape["append"] = (event) =>
    appendEventRow({
      eventId: event.eventId,
      type: event.type,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      occurredAt: event.occurredAt,
      commandId: event.commandId,
      payloadJson: JSON.stringify(event.payload),
    }).pipe(Effect.map(eventRowToOrchestrationEvent), Effect.orDie);

  const readFromSequence: OrchestrationEventRepositoryShape["readFromSequence"] = (
    sequenceExclusive,
    limit = 1_000,
  ) =>
    readEventRowsFromSequence({ sequenceExclusive, limit }).pipe(
      Effect.map((rows) => rows.map(eventRowToOrchestrationEvent)),
      Effect.orDie,
    );

  return {
    append,
    readFromSequence,
    readAll: () => readFromSequence(0, Number.MAX_SAFE_INTEGER),
  } satisfies OrchestrationEventRepositoryShape;
});

export const OrchestrationEventRepositoryLive = Layer.effect(
  OrchestrationEventRepository,
  makeRepository,
);

export function makeSqliteOrchestrationEventRepositoryLive(dbPath: string) {
  const SqliteClientLive = Effect.gen(function* () {
    yield* Effect.try({
      try: () => fs.mkdirSync(path.dirname(dbPath), { recursive: true }),
      catch: (error) => Effect.die(error),
    })
    return SqliteClient.layer({ filename: dbPath });
  }).pipe(Layer.unwrapEffect)

  const OrchestrationSqlLive = Layer.scoped(
    OrchestrationSql,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL;`;
      yield* sql`PRAGMA foreign_keys = ON;`;
      yield* runMigrations;
      return sql;
    }),
  ).pipe(Layer.provide(SqliteClientLive));

  return OrchestrationEventRepositoryLive.pipe(Layer.provide(OrchestrationSqlLive));
}
