import {
  ApplicationProjectEvent,
  type ApplicationStoredEvent,
  CommandId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationV2DomainEventJson,
  OrchestrationV2StoredEvent,
  ProjectId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import {
  OrchestrationActorKind,
  OrchestrationAggregateKind,
  OrchestrationEvent,
  OrchestrationEventMetadata,
  OrchestrationEventType,
} from "@t3tools/contracts/legacy-orchestration";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type OrchestrationEventStoreError,
} from "../Errors.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../Services/OrchestrationEventStore.ts";

const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const decodeProjectEvent = Schema.decodeUnknownEffect(ApplicationProjectEvent);
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const EventMetadataFromJsonString = Schema.fromJsonString(OrchestrationEventMetadata);

const AppendEventRequestSchema = Schema.Struct({
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  streamId: Schema.Union([ProjectId, ThreadId]),
  type: OrchestrationEventType,
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  actorKind: OrchestrationActorKind,
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  payloadJson: UnknownFromJsonString,
  metadataJson: EventMetadataFromJsonString,
  applicationEventVersion: Schema.Number,
});

const OrchestrationEventPersistedRowSchema = Schema.Struct({
  sequence: NonNegativeInt,
  eventId: EventId,
  type: OrchestrationEventType,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  payload: UnknownFromJsonString,
  metadata: EventMetadataFromJsonString,
});

const ReadFromSequenceRequestSchema = Schema.Struct({
  sequenceExclusive: NonNegativeInt,
  limit: Schema.Number,
});
const DEFAULT_READ_FROM_SEQUENCE_LIMIT = 1_000;
const READ_PAGE_SIZE = 500;

interface ApplicationEventRow {
  readonly sequence: number;
  readonly event_id: string;
  readonly command_id: string | null;
  readonly aggregate_kind: "project" | "thread";
  readonly stream_id: string;
  readonly event_type: string;
  readonly occurred_at: string;
  readonly payload_json: string;
  readonly metadata_json: string;
  readonly application_event_version: number;
  readonly causation_event_id: string | null;
  readonly correlation_id: string | null;
}

const decodeV2EventJson = Schema.decodeUnknownEffect(OrchestrationV2DomainEventJson);
const encodeV2EventJson = Schema.encodeEffect(OrchestrationV2DomainEventJson);
const decodeV2StoredEvent = Schema.decodeUnknownEffect(OrchestrationV2StoredEvent);
const decodeJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const encodeJson = Schema.encodeEffect(Schema.UnknownFromJsonString);

function metadataForV2Event(event: OrchestrationV2DomainEvent): Record<string, unknown> {
  return {
    ...(event.runId === undefined ? {} : { runId: event.runId }),
    ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
    ...(event.driver === undefined ? {} : { driver: event.driver }),
    ...(event.providerInstanceId === undefined
      ? {}
      : { providerInstanceId: event.providerInstanceId }),
    ...(event.rawEventId === undefined ? {} : { rawEventId: event.rawEventId }),
  };
}

const rowToV2StoredEvent = Effect.fn("OrchestrationEventStore.rowToV2StoredEvent")(function* (
  row: ApplicationEventRow,
) {
  const payload = yield* decodeJson(row.payload_json);
  const metadata = yield* decodeJson(row.metadata_json);
  const values =
    typeof metadata === "object" && metadata !== null ? (metadata as Record<string, unknown>) : {};
  const event = yield* decodeV2EventJson({
    id: row.event_id,
    threadId: row.stream_id,
    type: row.event_type,
    occurredAt: row.occurred_at,
    payload,
    ...(values.runId === undefined ? {} : { runId: values.runId }),
    ...(values.nodeId === undefined ? {} : { nodeId: values.nodeId }),
    ...(values.driver === undefined ? {} : { driver: values.driver }),
    ...(values.providerInstanceId === undefined
      ? {}
      : { providerInstanceId: values.providerInstanceId }),
    ...(values.rawEventId === undefined ? {} : { rawEventId: values.rawEventId }),
  });
  return yield* decodeV2StoredEvent({
    sequence: row.sequence,
    commandId: row.command_id,
    event,
  });
});

const rowToProjectEvent = Effect.fn("OrchestrationEventStore.rowToProjectEvent")(function* (
  row: ApplicationEventRow,
) {
  return yield* decodeProjectEvent({
    sequence: row.sequence,
    eventId: row.event_id,
    type: row.event_type,
    aggregateKind: row.aggregate_kind,
    aggregateId: row.stream_id,
    occurredAt: row.occurred_at,
    commandId: row.command_id,
    causationEventId: row.causation_event_id,
    correlationId: row.correlation_id,
    payload: yield* decodeJson(row.payload_json),
    metadata: yield* decodeJson(row.metadata_json),
  });
});

function rowToApplicationStoredEvent(
  row: ApplicationEventRow,
): Effect.Effect<ApplicationStoredEvent, Schema.SchemaError> {
  return row.aggregate_kind === "project" ? rowToProjectEvent(row) : rowToV2StoredEvent(row);
}

function inferActorKind(
  event: Omit<OrchestrationEvent, "sequence">,
): Schema.Schema.Type<typeof OrchestrationActorKind> {
  if (event.commandId !== null && event.commandId.startsWith("provider:")) {
    return "provider";
  }
  if (event.commandId !== null && event.commandId.startsWith("server:")) {
    return "server";
  }
  if (
    event.metadata.providerTurnId !== undefined ||
    event.metadata.providerItemId !== undefined ||
    event.metadata.adapterKey !== undefined
  ) {
    return "provider";
  }
  if (event.commandId === null) {
    return "server";
  }
  return "client";
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): OrchestrationEventStoreError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeEventStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const committedEvents = yield* PubSub.unbounded<ApplicationStoredEvent>();

  const appendEventRow = SqlSchema.findOne({
    Request: AppendEventRequestSchema,
    Result: OrchestrationEventPersistedRowSchema,
    execute: (request) =>
      sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
          , application_event_version
        )
        VALUES (
          ${request.eventId},
          ${request.aggregateKind},
          ${request.streamId},
          COALESCE(
            (
              SELECT stream_version + 1
              FROM orchestration_events
              WHERE aggregate_kind = ${request.aggregateKind}
                AND stream_id = ${request.streamId}
              ORDER BY stream_version DESC
              LIMIT 1
            ),
            0
          ),
          ${request.type},
          ${request.occurredAt},
          ${request.commandId},
          ${request.causationEventId},
          ${request.correlationId},
          ${request.actorKind},
          ${request.payloadJson},
          ${request.metadataJson}
          , ${request.applicationEventVersion}
        )
        RETURNING
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_kind AS "aggregateKind",
          stream_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payload",
          metadata_json AS "metadata"
      `,
  });

  const readEventRowsFromSequence = SqlSchema.findAll({
    Request: ReadFromSequenceRequestSchema,
    Result: OrchestrationEventPersistedRowSchema,
    execute: (request) =>
      sql`
        SELECT
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_kind AS "aggregateKind",
          stream_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payload",
          metadata_json AS "metadata"
        FROM orchestration_events
        WHERE sequence > ${request.sequenceExclusive}
          AND (application_event_version = 1 OR aggregate_kind = 'project')
        ORDER BY sequence ASC
        LIMIT ${request.limit}
      `,
  });

  const append: OrchestrationEventStoreShape["append"] = (event) =>
    appendEventRow({
      eventId: event.eventId,
      aggregateKind: event.aggregateKind,
      streamId: event.aggregateId,
      type: event.type,
      causationEventId: event.causationEventId,
      correlationId: event.correlationId,
      actorKind: inferActorKind(event),
      occurredAt: event.occurredAt,
      commandId: event.commandId,
      payloadJson: event.payload,
      metadataJson: event.metadata,
      applicationEventVersion: event.aggregateKind === "project" ? 2 : 1,
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "OrchestrationEventStore.append:insert",
          "OrchestrationEventStore.append:decodeRow",
        ),
      ),
      Effect.flatMap((row) =>
        decodeEvent(row).pipe(
          Effect.mapError(toPersistenceDecodeError("OrchestrationEventStore.append:rowToEvent")),
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
    const readPage = (
      cursor: number,
      remaining: number,
    ): Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError> =>
      Stream.fromEffect(
        readEventRowsFromSequence({
          sequenceExclusive: cursor,
          limit: Math.min(remaining, READ_PAGE_SIZE),
        }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "OrchestrationEventStore.readFromSequence:query",
              "OrchestrationEventStore.readFromSequence:decodeRows",
            ),
          ),
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              decodeEvent(row).pipe(
                Effect.mapError(
                  toPersistenceDecodeError("OrchestrationEventStore.readFromSequence:rowToEvent"),
                ),
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

  const readApplicationRows = (input: {
    readonly afterSequence: number;
    readonly throughSequence?: number;
    readonly threadId?: ThreadId;
    readonly commandId?: CommandId;
    readonly onlyAgentEvents?: boolean;
    readonly limit: number;
  }) =>
    sql<ApplicationEventRow>`
      SELECT
        sequence,
        event_id,
        command_id,
        aggregate_kind,
        stream_id,
        event_type,
        occurred_at,
        payload_json,
        metadata_json,
        application_event_version,
        causation_event_id,
        correlation_id
      FROM orchestration_events
      WHERE sequence > ${input.afterSequence}
        AND sequence <= ${input.throughSequence ?? Number.MAX_SAFE_INTEGER}
        AND (
          (${input.onlyAgentEvents === true ? 1 : 0} = 0 AND aggregate_kind = 'project')
          OR (application_event_version = 2 AND aggregate_kind = 'thread')
        )
        AND (${input.threadId ?? null} IS NULL OR stream_id = ${input.threadId ?? null})
        AND (${input.commandId ?? null} IS NULL OR command_id = ${input.commandId ?? null})
      ORDER BY sequence ASC
      LIMIT ${input.limit}
    `;

  const appendAgentEvents: OrchestrationEventStoreShape["appendAgentEvents"] = (input) =>
    Effect.forEach(
      input.events,
      (event) =>
        Effect.gen(function* () {
          const encoded = yield* encodeV2EventJson(event);
          const rows = yield* sql<{ readonly sequence: number }>`
            INSERT INTO orchestration_events (
              event_id,
              aggregate_kind,
              stream_id,
              stream_version,
              event_type,
              occurred_at,
              command_id,
              causation_event_id,
              correlation_id,
              actor_kind,
              payload_json,
              metadata_json,
              application_event_version
            )
            VALUES (
              ${event.id},
              'thread',
              ${event.threadId},
              COALESCE(
                (
                  SELECT MAX(stream_version) + 1
                  FROM orchestration_events
                  WHERE aggregate_kind = 'thread' AND stream_id = ${event.threadId}
                ),
                0
              ),
              ${event.type},
              ${encoded.occurredAt},
              ${input.commandId ?? null},
              NULL,
              ${input.commandId ?? null},
              ${event.rawEventId === undefined ? "server" : "provider"},
              ${yield* encodeJson(encoded.payload)},
              ${yield* encodeJson(metadataForV2Event(event))},
              2
            )
            RETURNING sequence
          `;
          return yield* decodeV2StoredEvent({
            sequence: rows[0]?.sequence,
            commandId: input.commandId ?? null,
            event,
          });
        }),
      { concurrency: 1 },
    ).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "OrchestrationEventStore.appendAgentEvents:insert",
          "OrchestrationEventStore.appendAgentEvents:decode",
        ),
      ),
    );

  const readAgentEvents: OrchestrationEventStoreShape["readAgentEvents"] = (input) =>
    Stream.fromEffect(
      readApplicationRows({
        afterSequence: input?.afterSequence ?? 0,
        ...(input?.throughSequence === undefined ? {} : { throughSequence: input.throughSequence }),
        ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
        ...(input?.commandId === undefined ? {} : { commandId: input.commandId }),
        onlyAgentEvents: true,
        limit: input?.limit ?? DEFAULT_READ_FROM_SEQUENCE_LIMIT,
      }).pipe(
        Effect.mapError(toPersistenceSqlError("OrchestrationEventStore.readAgentEvents:query")),
      ),
    ).pipe(
      Stream.flatMap(Stream.fromIterable),
      Stream.mapEffect((row) =>
        rowToV2StoredEvent(row).pipe(
          Effect.mapError(
            toPersistenceDecodeError("OrchestrationEventStore.readAgentEvents:decode"),
          ),
        ),
      ),
    );

  const latestAgentSequence: OrchestrationEventStoreShape["latestAgentSequence"] = (threadId) =>
    sql<{ readonly sequence: number | null }>`
      SELECT MAX(sequence) AS sequence
      FROM orchestration_events
      WHERE application_event_version = 2
        AND aggregate_kind = 'thread'
        AND (${threadId ?? null} IS NULL OR stream_id = ${threadId ?? null})
    `.pipe(
      Effect.map((rows) => rows[0]?.sequence ?? 0),
      Effect.mapError(toPersistenceSqlError("OrchestrationEventStore.latestAgentSequence:query")),
    );

  const latestApplicationSequence = sql<{ readonly sequence: number | null }>`
    SELECT MAX(sequence) AS sequence
    FROM orchestration_events
    WHERE aggregate_kind = 'project'
      OR (application_event_version = 2 AND aggregate_kind = 'thread')
  `.pipe(
    Effect.map((rows) => rows[0]?.sequence ?? 0),
    Effect.mapError(
      toPersistenceSqlError("OrchestrationEventStore.latestApplicationSequence:query"),
    ),
  );

  const readApplicationEvents = (input: {
    readonly afterSequence: number;
    readonly throughSequence: number;
    readonly limit: number;
  }): Stream.Stream<ApplicationStoredEvent, OrchestrationEventStoreError> =>
    Stream.fromEffect(
      readApplicationRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("OrchestrationEventStore.readApplicationEvents:query"),
        ),
      ),
    ).pipe(
      Stream.flatMap(Stream.fromIterable),
      Stream.mapEffect((row) =>
        rowToApplicationStoredEvent(row).pipe(
          Effect.mapError(
            toPersistenceDecodeError("OrchestrationEventStore.readApplicationEvents:decode"),
          ),
        ),
      ),
    );

  const catchUpApplicationEvents = (input: {
    readonly afterSequence: number;
    readonly throughSequence: number;
  }): Stream.Stream<ApplicationStoredEvent, OrchestrationEventStoreError> => {
    const loop = (
      afterSequence: number,
    ): Stream.Stream<ApplicationStoredEvent, OrchestrationEventStoreError> =>
      Stream.unwrap(
        readApplicationEvents({
          afterSequence,
          throughSequence: input.throughSequence,
          limit: READ_PAGE_SIZE,
        }).pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.map((events) => {
            if (events.length === 0) return Stream.empty;
            const current = Stream.fromIterable(events);
            const last = events.at(-1)?.sequence ?? input.throughSequence;
            return events.length < READ_PAGE_SIZE || last >= input.throughSequence
              ? current
              : Stream.concat(current, loop(last));
          }),
        ),
      );
    return loop(input.afterSequence);
  };

  const streamApplicationEvents: OrchestrationEventStoreShape["streamApplicationEvents"] = (
    input,
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(committedEvents);
        const highWater = yield* latestApplicationSequence;
        const afterSequence = input?.afterSequence ?? 0;
        const replay = catchUpApplicationEvents({
          afterSequence,
          throughSequence: highWater,
        });
        const live = Stream.fromSubscription(subscription).pipe(
          Stream.filter((event) => event.sequence > Math.max(highWater, afterSequence)),
        );
        return Stream.concat(replay, live);
      }),
    );

  return {
    append,
    readFromSequence,
    readAll: () => readFromSequence(0, Number.MAX_SAFE_INTEGER),
    appendAgentEvents,
    readAgentEvents,
    latestAgentSequence,
    latestApplicationSequence,
    publishCommitted: (events) => PubSub.publishAll(committedEvents, events).pipe(Effect.asVoid),
    streamApplicationEvents,
  } satisfies OrchestrationEventStoreShape;
});

export const OrchestrationEventStoreLive = Layer.effect(OrchestrationEventStore, makeEventStore);
