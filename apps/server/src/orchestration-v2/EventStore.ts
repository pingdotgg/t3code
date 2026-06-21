import {
  CommandId,
  OrchestrationV2DomainEvent,
  OrchestrationV2StoredEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";

export class EventStoreAppendEventsError extends Schema.TaggedErrorClass<EventStoreAppendEventsError>()(
  "EventStoreAppendEventsError",
  {
    eventCount: Schema.Number,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to append ${this.eventCount} agent orchestration event(s).`;
  }
}

export class EventStoreReadEventsError extends Schema.TaggedErrorClass<EventStoreReadEventsError>()(
  "EventStoreReadEventsError",
  {
    afterSequence: Schema.optional(Schema.Number),
    threadId: Schema.optional(ThreadId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.threadId === undefined
      ? "Failed to read agent orchestration events."
      : `Failed to read agent orchestration events for thread ${this.threadId}.`;
  }
}

export const EventStoreV2Error = Schema.Union([
  EventStoreAppendEventsError,
  EventStoreReadEventsError,
]);
export type EventStoreV2Error = typeof EventStoreV2Error.Type;

export interface EventStoreV2Shape {
  readonly append: (input: {
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, EventStoreV2Error>;
  readonly read: (input?: {
    readonly afterSequence?: number;
    readonly throughSequence?: number;
    readonly threadId?: ThreadId;
    readonly limit?: number;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventStoreV2Error>;
  readonly readByCommandId: (input: {
    readonly commandId: CommandId;
  }) => Stream.Stream<OrchestrationV2StoredEvent, EventStoreV2Error>;
  readonly latestSequence: (input?: {
    readonly threadId?: ThreadId;
  }) => Effect.Effect<number, EventStoreV2Error>;
  readonly publishCommitted: (
    events: ReadonlyArray<OrchestrationV2StoredEvent>,
  ) => Effect.Effect<void>;
}

export class EventStoreV2 extends Context.Service<EventStoreV2, EventStoreV2Shape>()(
  "t3/orchestration-v2/EventStore/EventStoreV2",
) {}

const baseLayer: Layer.Layer<EventStoreV2, never, OrchestrationEventStore> = Layer.effect(
  EventStoreV2,
  Effect.gen(function* () {
    const applicationEvents = yield* OrchestrationEventStore;

    const read: EventStoreV2Shape["read"] = (input) =>
      applicationEvents
        .readAgentEvents({
          ...(input?.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
          ...(input?.throughSequence === undefined
            ? {}
            : { throughSequence: input.throughSequence }),
          ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
          ...(input?.limit === undefined ? {} : { limit: input.limit }),
        })
        .pipe(
          Stream.mapError(
            (cause) =>
              new EventStoreReadEventsError({
                ...(input?.afterSequence === undefined
                  ? {}
                  : { afterSequence: input.afterSequence }),
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                cause,
              }),
          ),
        );

    return EventStoreV2.of({
      append: (input) =>
        applicationEvents.appendAgentEvents(input).pipe(
          Effect.mapError(
            (cause) =>
              new EventStoreAppendEventsError({
                eventCount: input.events.length,
                cause,
              }),
          ),
        ),
      read,
      readByCommandId: ({ commandId }) =>
        applicationEvents
          .readAgentEvents({ commandId })
          .pipe(Stream.mapError((cause) => new EventStoreReadEventsError({ cause }))),
      latestSequence: (input) =>
        applicationEvents.latestAgentSequence(input?.threadId).pipe(
          Effect.mapError(
            (cause) =>
              new EventStoreReadEventsError({
                ...(input?.threadId === undefined ? {} : { threadId: input.threadId }),
                cause,
              }),
          ),
        ),
      publishCommitted: applicationEvents.publishCommitted,
    });
  }),
);

export const layer: Layer.Layer<EventStoreV2, never, SqlClient.SqlClient> = baseLayer.pipe(
  Layer.provide(OrchestrationEventStoreLive),
);

export const layerFromOrchestrationEventStore = baseLayer;
