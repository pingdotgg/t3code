import {
  OrchestrationV2DomainEvent,
  OrchestrationV2RawProviderEvent,
  RawEventId,
} from "@t3tools/contracts";
import { Context, Schema } from "effect";
import type { Effect, Stream } from "effect";

export class EventLogAppendRawProviderEventError extends Schema.TaggedErrorClass<EventLogAppendRawProviderEventError>()(
  "EventLogAppendRawProviderEventError",
  {
    eventType: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to append raw provider event ${this.eventType}.`;
  }
}

export class EventLogAppendDomainEventsError extends Schema.TaggedErrorClass<EventLogAppendDomainEventsError>()(
  "EventLogAppendDomainEventsError",
  {
    eventCount: Schema.Number,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to append ${this.eventCount} orchestration domain event(s).`;
  }
}

export class EventLogReadDomainEventsError extends Schema.TaggedErrorClass<EventLogReadDomainEventsError>()(
  "EventLogReadDomainEventsError",
  {
    afterSequence: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return this.afterSequence === undefined
      ? "Failed to read orchestration domain events."
      : `Failed to read orchestration domain events after sequence ${this.afterSequence}.`;
  }
}

export const EventLogV2Error = Schema.Union([
  EventLogAppendRawProviderEventError,
  EventLogAppendDomainEventsError,
  EventLogReadDomainEventsError,
]);
export type EventLogV2Error = typeof EventLogV2Error.Type;

export interface EventLogV2Shape {
  readonly appendRawProviderEvent: (
    event: OrchestrationV2RawProviderEvent,
  ) => Effect.Effect<RawEventId, EventLogV2Error>;
  readonly appendDomainEvents: (
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
  ) => Effect.Effect<void, EventLogV2Error>;
  readonly readDomainEvents: (input: {
    readonly afterSequence?: number;
  }) => Stream.Stream<OrchestrationV2DomainEvent, EventLogV2Error>;
}

export class EventLogV2 extends Context.Service<EventLogV2, EventLogV2Shape>()(
  "t3/orchestration-v2/Services/EventLog",
) {}
