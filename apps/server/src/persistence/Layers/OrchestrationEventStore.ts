import type { OrchestrationEvent } from "@t3tools/contracts";
import { OrchestrationEventSchema } from "@t3tools/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema, Stream } from "effect";

import {
  toPersistenceDecodeCauseError,
  toPersistenceDecodeError,
  toPersistenceSerializationError,
  toPersistenceSqlError,
  type OrchestrationEventStoreError,
} from "../Errors.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../Services/OrchestrationEventStore.ts";

const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEventSchema);

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
const DEFAULT_READ_FROM_SEQUENCE_LIMIT = 1_000;
const READ_PAGE_SIZE = 500;

function eventRowToOrchestrationEvent(
  row: Schema.Schema.Type<typeof EventRowSchema>,
  operation: string,
): Effect.Effect<OrchestrationEvent, OrchestrationEventStoreError> {
  return Effect.try({
    try: () => JSON.parse(row.payloadJson) as unknown,
    catch: toPersistenceDecodeCauseError(`${operation}:parsePayloadJson`),
  }).pipe(
    Effect.flatMap((payload) =>
      decodeEvent({
        sequence: row.sequence,
        eventId: row.eventId,
        type: row.type,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        occurredAt: row.occurredAt,
        commandId: row.commandId,
        payload,
      }).pipe(Effect.mapError(toPersistenceDecodeError(`${operation}:decodeEvent`))),
    ),
  );
}

const makeEventStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const appendEventRow = SqlSchema.findOne({
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

  const append: OrchestrationEventStoreShape["append"] = (event) =>
    Effect.try({
      try: () => JSON.stringify(event.payload),
      catch: toPersistenceSerializationError("OrchestrationEventStore.append:encodePayload"),
    }).pipe(
      Effect.flatMap((payloadJson) =>
        appendEventRow({
          eventId: event.eventId,
          type: event.type,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          occurredAt: event.occurredAt,
          commandId: event.commandId,
          payloadJson,
        }).pipe(
          Effect.mapError(toPersistenceSqlError("OrchestrationEventStore.append:insert")),
          Effect.flatMap((row) =>
            eventRowToOrchestrationEvent(row, "OrchestrationEventStore.append:rowToEvent"),
          ),
        ),
      ),
    );

  const readFromSequence: OrchestrationEventStoreShape["readFromSequence"] = (
    sequenceExclusive,
    limit = DEFAULT_READ_FROM_SEQUENCE_LIMIT,
  ) => {
    const normalizedLimit = Math.max(0, Math.floor(limit));
    if (normalizedLimit === 0) {
      return Stream.empty;
    }
    const readPage = (cursor: number, remaining: number): Stream.Stream<
      OrchestrationEvent,
      OrchestrationEventStoreError
    > =>
      Stream.fromEffect(
        readEventRowsFromSequence({
          sequenceExclusive: cursor,
          limit: Math.min(remaining, READ_PAGE_SIZE),
        }).pipe(
          Effect.mapError(toPersistenceSqlError("OrchestrationEventStore.readFromSequence:query")),
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              eventRowToOrchestrationEvent(
                row,
                "OrchestrationEventStore.readFromSequence:rowToEvent",
              ),
            ),
          ),
        ),
      ).pipe(
        Stream.flatMap((events) => {
          if (events.length === 0) {
            return Stream.empty;
          }
          const nextRemaining = remaining - events.length;
          if (nextRemaining <= 0) {
            return Stream.fromIterable(events);
          }
          return Stream.concat(
            Stream.fromIterable(events),
            readPage(events[events.length - 1]!.sequence, nextRemaining),
          );
        }),
      );

    return readPage(sequenceExclusive, normalizedLimit);
  };

  return {
    append,
    readFromSequence,
    readAll: () => readFromSequence(0, Number.MAX_SAFE_INTEGER),
  } satisfies OrchestrationEventStoreShape;
});

export const OrchestrationEventStoreLive = Layer.effect(
  OrchestrationEventStore,
  makeEventStore,
);
