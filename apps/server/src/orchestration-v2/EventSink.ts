import {
  CommandId,
  OrchestrationV2DomainEvent,
  OrchestrationV2StoredEvent,
  ThreadId,
} from "@t3tools/contracts";
import { Context, Effect, Layer, PubSub, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { EventStoreV2 } from "./EventStore.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";

/**
 * ERRORS
 */
export class EventSinkWriteError extends Schema.TaggedErrorClass<EventSinkWriteError>()(
  "EventSinkWriteError",
  {
    eventCount: Schema.Number,
    commandId: Schema.optional(CommandId),
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to write ${this.eventCount} orchestration V2 event(s).`;
  }
}

export class EventSinkStreamError extends Schema.TaggedErrorClass<EventSinkStreamError>()(
  "EventSinkStreamError",
  {
    threadId: Schema.optional(ThreadId),
    afterSequence: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return this.threadId === undefined
      ? "Failed to stream orchestration V2 events."
      : `Failed to stream orchestration V2 events for thread ${this.threadId}.`;
  }
}

export const EventSinkV2Error = Schema.Union([EventSinkWriteError, EventSinkStreamError]);
export type EventSinkV2Error = typeof EventSinkV2Error.Type;

/**
 * SERVICE DEFINITION
 */
export interface EventSinkV2Shape {
  readonly write: (input: {
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, EventSinkV2Error>;
  readonly stream: (input?: {
    readonly threadId?: ThreadId;
    readonly afterSequence?: number;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventSinkV2Error>;
  readonly latestSequence: (input?: {
    readonly threadId?: ThreadId;
  }) => Effect.Effect<number, EventSinkV2Error>;
  readonly readByCommandId: (input: {
    readonly commandId: CommandId;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventSinkV2Error>;
}

export class EventSinkV2 extends Context.Service<EventSinkV2, EventSinkV2Shape>()(
  "t3/orchestration-v2/EventSink",
) {}

/**
 * IMPLEMENTATIONS
 */
export const layer: Layer.Layer<
  EventSinkV2,
  never,
  EventStoreV2 | ProjectionStoreV2 | SqlClient.SqlClient
> = Layer.effect(
  EventSinkV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* EventStoreV2;
    const projectionStore = yield* ProjectionStoreV2;
    const liveEvents = yield* PubSub.unbounded<OrchestrationV2StoredEvent>();

    return EventSinkV2.of({
      write: (input) =>
        Effect.gen(function* () {
          const storedEvents = yield* sql.withTransaction(
            Effect.gen(function* () {
              const committed = yield* eventStore.append({
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                events: input.events,
              });
              yield* Effect.forEach(committed, (stored) => projectionStore.apply(stored.event), {
                concurrency: 1,
              });
              return committed;
            }),
          );
          yield* PubSub.publishAll(liveEvents, storedEvents);
          return storedEvents;
        }).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkWriteError({
                eventCount: input.events.length,
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                cause,
              }),
          ),
        ),
      stream: (input) =>
        eventStore.read(input).pipe(
          Stream.concat(
            Stream.fromPubSub(liveEvents).pipe(
              Stream.filter(
                (stored) =>
                  input?.threadId === undefined || stored.event.threadId === input.threadId,
              ),
              Stream.filter(
                (stored) =>
                  input?.afterSequence === undefined || stored.sequence > input.afterSequence,
              ),
            ),
          ),
          Stream.mapError(
            (cause) =>
              new EventSinkStreamError({
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                ...(input?.afterSequence === undefined
                  ? {}
                  : { afterSequence: input.afterSequence }),
                cause,
              }),
          ),
        ),
      latestSequence: (input) =>
        eventStore.latestSequence(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventSinkStreamError({
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                cause,
              }),
          ),
        ),
      readByCommandId: (input) =>
        eventStore.readByCommandId(input).pipe(
          Stream.mapError(
            (cause) =>
              new EventSinkStreamError({
                cause,
              }),
          ),
        ),
    } satisfies EventSinkV2Shape);
  }),
);
