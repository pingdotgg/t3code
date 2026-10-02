/**
 * Historical name for the shared application event store.
 *
 * Owns durable append/replay access for project events and V2 agent-thread
 * events under one global sequence. It does not reduce events into read models
 * or apply command validation rules.
 *
 * Uses Effect `Context.Service` for dependency injection and exposes typed
 * persistence/decode errors for event append and replay operations.
 *
 * @module OrchestrationEventStore
 */
import type {
  ApplicationProjectEvent,
  ApplicationStoredEvent,
  CommandId,
  OrchestrationV2DomainEvent,
  OrchestrationV2StoredEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { OrchestrationEventStoreError } from "../Errors.ts";

/** A project event before the store assigns its sequence. */
export type UnsequencedProjectEvent = ApplicationProjectEvent extends infer Event
  ? Event extends ApplicationProjectEvent
    ? Omit<Event, "sequence">
    : never
  : never;

/**
 * OrchestrationEventStoreShape - Service API for orchestration event persistence.
 */
export interface OrchestrationEventStoreShape {
  /** Append one project event to the shared application log. */
  readonly appendProjectEvent: (
    event: UnsequencedProjectEvent,
  ) => Effect.Effect<ApplicationProjectEvent, OrchestrationEventStoreError>;

  /** Append V2 agent events to the same globally ordered application log. */
  readonly appendAgentEvents: (input: {
    readonly commandId?: CommandId;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, OrchestrationEventStoreError>;

  /**
   * Read only V2 thread events from the application log.
   *
   * Reads in fixed-size sequence pages until the filtered range is exhausted;
   * `limit` caps the total emitted events across pages.
   *
   * A row whose `event_type` this build does not know fails the read unless
   * `skipUnknownEventTypes` is set, which logs and drops it instead. Only
   * client thread replay opts in; anything that builds server state stays strict.
   */
  readonly readAgentEvents: (input?: {
    readonly afterSequence?: number;
    readonly throughSequence?: number;
    readonly threadId?: ThreadId;
    readonly commandId?: CommandId;
    readonly eventType?: OrchestrationV2DomainEvent["type"];
    readonly limit?: number;
    readonly skipUnknownEventTypes?: boolean;
  }) => Stream.Stream<OrchestrationV2StoredEvent, OrchestrationEventStoreError>;

  /** Measure one thread's bounded replay without loading or decoding its payloads. */
  readonly getAgentReplayStats: (input: {
    readonly threadId: ThreadId;
    readonly afterSequence: number;
    readonly throughSequence: number;
    readonly maxEvents: number;
  }) => Effect.Effect<
    {
      readonly eventCount: number;
      /** UTF-8 bytes in persisted payload JSON before decoding or wire projection. */
      readonly rawPayloadBytes: number;
      readonly hasCreateEvent: boolean;
    },
    OrchestrationEventStoreError
  >;

  /**
   * Measure the retained application-event range `(afterSequence, throughSequence]`
   * without loading or decoding its payloads.
   */
  readonly getReplayStats: (input: {
    readonly afterSequence: number;
    readonly throughSequence: number;
  }) => Effect.Effect<
    {
      readonly eventCount: number;
      /** UTF-8 bytes in persisted payload JSON before decoding or wire projection. */
      readonly rawPayloadBytes: number;
    },
    OrchestrationEventStoreError
  >;

  readonly latestAgentSequence: (
    threadId?: ThreadId,
  ) => Effect.Effect<number, OrchestrationEventStoreError>;

  readonly latestApplicationSequence: Effect.Effect<number, OrchestrationEventStoreError>;

  /** Read the finite retained application-event range `(afterSequence, throughSequence]`. */
  readonly readApplicationEvents: (input: {
    readonly afterSequence: number;
    readonly throughSequence: number;
  }) => Stream.Stream<ApplicationStoredEvent, OrchestrationEventStoreError>;

  /** Publish only after the surrounding event/projection transaction commits. */
  readonly publishCommitted: (events: ReadonlyArray<ApplicationStoredEvent>) => Effect.Effect<void>;

  /** Race-free replay-to-live stream for project and V2 thread events. */
  readonly streamApplicationEvents: (input?: {
    readonly afterSequence?: number;
  }) => Stream.Stream<ApplicationStoredEvent, OrchestrationEventStoreError>;
  /** Project transport events before bounding replay and the live tail. */
  readonly streamProjectedApplicationEvents: <A extends { readonly sequence: number }>(input: {
    readonly afterSequence?: number;
    readonly project: (event: ApplicationStoredEvent) => A;
  }) => Stream.Stream<A, OrchestrationEventStoreError>;
}

/** OrchestrationEventStore - Service tag for the shared application event log. */
export class OrchestrationEventStore extends Context.Service<
  OrchestrationEventStore,
  OrchestrationEventStoreShape
>()("t3/persistence/Services/OrchestrationEventStore") {}
