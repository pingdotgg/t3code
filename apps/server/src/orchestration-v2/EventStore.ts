import {
  CommandId,
  OrchestrationV2DomainEvent,
  OrchestrationV2DomainEventJson,
  OrchestrationV2StoredEvent,
  ThreadId,
} from "@t3tools/contracts";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * ERRORS
 */
export class EventStoreAppendEventsError extends Schema.TaggedErrorClass<EventStoreAppendEventsError>()(
  "EventStoreAppendEventsError",
  {
    eventCount: Schema.Number,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to append ${this.eventCount} orchestration V2 event(s).`;
  }
}

export class EventStoreReadEventsError extends Schema.TaggedErrorClass<EventStoreReadEventsError>()(
  "EventStoreReadEventsError",
  {
    afterSequence: Schema.optional(Schema.Number),
    threadId: Schema.optional(ThreadId),
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return this.threadId === undefined
      ? "Failed to read orchestration V2 events."
      : `Failed to read orchestration V2 events for thread ${this.threadId}.`;
  }
}

export const EventStoreV2Error = Schema.Union([
  EventStoreAppendEventsError,
  EventStoreReadEventsError,
]);
export type EventStoreV2Error = typeof EventStoreV2Error.Type;

/**
 * SERVICE DEFINITION
 */
export interface EventStoreV2Shape {
  readonly append: (input: {
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, EventStoreV2Error>;
  readonly read: (input?: {
    readonly afterSequence?: number;
    readonly threadId?: ThreadId;
    readonly limit?: number;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventStoreV2Error>;
  readonly readByCommandId: (input: {
    readonly commandId: CommandId;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventStoreV2Error>;
  readonly latestSequence: (input?: {
    readonly threadId?: ThreadId;
  }) => Effect.Effect<number, EventStoreV2Error>;
}

export class EventStoreV2 extends Context.Service<EventStoreV2, EventStoreV2Shape>()(
  "t3/orchestration-v2/EventStore",
) {}

/**
 * IMPLEMENTATIONS
 */
type EventRow = {
  readonly sequence: number;
  readonly event_id: string;
  readonly command_id: string | null;
  readonly thread_id: string;
  readonly run_id: string | null;
  readonly node_id: string | null;
  readonly provider: string | null;
  readonly raw_event_id: string | null;
  readonly event_type: string;
  readonly occurred_at: string;
  readonly payload_json: string;
};

const encodeEventJson = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2DomainEventJson));
const decodeEventJson = Schema.decodeUnknownEffect(OrchestrationV2DomainEventJson);
const decodeStoredEvent = Schema.decodeUnknownEffect(OrchestrationV2StoredEvent);

function parseJson(json: string): unknown {
  return JSON.parse(json) as unknown;
}

function compactUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export const layer: Layer.Layer<EventStoreV2, never, SqlClient.SqlClient> = Layer.effect(
  EventStoreV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rowToStoredEvent = (
      row: EventRow,
      input?: { readonly afterSequence?: number; readonly threadId?: ThreadId },
    ) =>
      decodeEventJson(
        compactUndefined({
          id: row.event_id,
          threadId: row.thread_id,
          runId: row.run_id ?? undefined,
          nodeId: row.node_id ?? undefined,
          provider: row.provider ?? undefined,
          rawEventId: row.raw_event_id ?? undefined,
          type: row.event_type,
          occurredAt: row.occurred_at,
          payload: parseJson(row.payload_json),
        }),
      ).pipe(
        Effect.flatMap((event) =>
          decodeStoredEvent({
            sequence: row.sequence,
            commandId: row.command_id,
            event,
          }),
        ),
        Effect.mapError(
          (cause) =>
            new EventStoreReadEventsError({
              ...(input?.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
              ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
              cause,
            }),
        ),
      );

    const append: EventStoreV2Shape["append"] = (input) =>
      Effect.forEach(
        input.events,
        (event) =>
          Effect.gen(function* () {
            const encoded = yield* encodeEventJson(event);
            const normalized = parseJson(encoded) as {
              readonly payload: unknown;
              readonly occurredAt: string;
            };

            const rows = yield* sql<EventRow>`
              INSERT INTO orchestration_v2_events (
                event_id,
                command_id,
                thread_id,
                run_id,
                node_id,
                provider,
                raw_event_id,
                event_type,
                occurred_at,
                payload_json
              )
              VALUES (
                ${event.id},
                ${input.commandId ?? null},
                ${event.threadId},
                ${event.runId ?? null},
                ${event.nodeId ?? null},
                ${event.provider ?? null},
                ${event.rawEventId ?? null},
                ${event.type},
                ${normalized.occurredAt},
                ${JSON.stringify(normalized.payload)}
              )
              RETURNING
                sequence,
                event_id,
                command_id,
                thread_id,
                run_id,
                node_id,
                provider,
                raw_event_id,
                event_type,
                occurred_at,
                payload_json
            `;
            const row = rows[0];
            if (!row) {
              return yield* new EventStoreAppendEventsError({
                eventCount: input.events.length,
                cause: "Insert did not return a stored event row.",
              });
            }
            return yield* rowToStoredEvent(row).pipe(
              Effect.mapError(
                (cause) =>
                  new EventStoreAppendEventsError({
                    eventCount: input.events.length,
                    cause,
                  }),
              ),
            );
          }),
        { concurrency: 1 },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new EventStoreAppendEventsError({
              eventCount: input.events.length,
              cause,
            }),
        ),
      );

    const read: EventStoreV2Shape["read"] = (input) =>
      Stream.fromEffect(
        sql<EventRow>`
          SELECT
            sequence,
            event_id,
            command_id,
            thread_id,
            run_id,
            node_id,
            provider,
            raw_event_id,
            event_type,
            occurred_at,
            payload_json
          FROM orchestration_v2_events
          WHERE sequence > ${input?.afterSequence ?? 0}
            AND (${input?.threadId ?? null} IS NULL OR thread_id = ${input?.threadId ?? null})
          ORDER BY sequence ASC
          LIMIT ${input?.limit ?? 1000}
        `.pipe(
          Effect.mapError(
            (cause) =>
              new EventStoreReadEventsError({
                ...(input?.afterSequence === undefined
                  ? {}
                  : { afterSequence: input.afterSequence }),
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                cause,
              }),
          ),
        ),
      ).pipe(
        Stream.flatMap(Stream.fromIterable),
        Stream.mapEffect((row) => rowToStoredEvent(row, input)),
      );

    const readByCommandId: EventStoreV2Shape["readByCommandId"] = (input) =>
      Stream.fromEffect(
        sql<EventRow>`
          SELECT
            sequence,
            event_id,
            command_id,
            thread_id,
            run_id,
            node_id,
            provider,
            raw_event_id,
            event_type,
            occurred_at,
            payload_json
          FROM orchestration_v2_events
          WHERE command_id = ${input.commandId}
          ORDER BY sequence ASC
        `.pipe(
          Effect.mapError(
            (cause) =>
              new EventStoreReadEventsError({
                cause,
              }),
          ),
        ),
      ).pipe(
        Stream.flatMap(Stream.fromIterable),
        Stream.mapEffect((row) => rowToStoredEvent(row)),
      );

    const latestSequence: EventStoreV2Shape["latestSequence"] = (input) =>
      sql<{ readonly sequence: number | null }>`
        SELECT MAX(sequence) AS sequence
        FROM orchestration_v2_events
        WHERE ${input?.threadId ?? null} IS NULL OR thread_id = ${input?.threadId ?? null}
      `.pipe(
        Effect.map((rows) => rows[0]?.sequence ?? 0),
        Effect.mapError(
          (cause) =>
            new EventStoreReadEventsError({
              ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
              cause,
            }),
        ),
      );

    return {
      append,
      read,
      readByCommandId,
      latestSequence,
    } satisfies EventStoreV2Shape;
  }),
);
