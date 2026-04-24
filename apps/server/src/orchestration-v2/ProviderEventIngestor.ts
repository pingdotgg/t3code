import {
  NodeId,
  CommandId,
  OrchestrationV2DomainEvent,
  OrchestrationV2StoredEvent,
  ProviderSessionId,
  RawEventId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { Context, DateTime, Effect, Layer, Schema } from "effect";

import { EventSinkV2 } from "./EventSink.ts";
import { IdAllocatorV2 } from "./IdAllocator.ts";
import { ProviderAdapterV2Event } from "./ProviderAdapter.ts";

export class ProviderEventNormalizeError extends Schema.TaggedErrorClass<ProviderEventNormalizeError>()(
  "ProviderEventNormalizeError",
  {
    providerSessionId: ProviderSessionId,
    threadId: ThreadId,
    providerEvent: ProviderAdapterV2Event,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to normalize provider event ${this.providerEvent.type} for thread ${this.threadId}.`;
  }
}

export class ProviderEventPublishError extends Schema.TaggedErrorClass<ProviderEventPublishError>()(
  "ProviderEventPublishError",
  {
    providerSessionId: ProviderSessionId,
    eventCount: Schema.Number,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to publish ${this.eventCount} normalized provider event(s).`;
  }
}

export const ProviderEventIngestorV2Error = Schema.Union([
  ProviderEventNormalizeError,
  ProviderEventPublishError,
]);
export type ProviderEventIngestorV2Error = typeof ProviderEventIngestorV2Error.Type;

export interface ProviderEventIngestorV2Shape {
  readonly normalize: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly commandId?: CommandId;
    readonly threadId: ThreadId;
    readonly runId?: RunId;
    readonly nodeId?: NodeId;
    readonly rawEventId?: RawEventId;
    readonly event: ProviderAdapterV2Event;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2DomainEvent>, ProviderEventIngestorV2Error>;
  readonly ingestNormalized: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly commandId?: CommandId;
    readonly threadId: ThreadId;
    readonly runId?: RunId;
    readonly nodeId?: NodeId;
    readonly rawEventId?: RawEventId;
    readonly event: ProviderAdapterV2Event;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, ProviderEventIngestorV2Error>;
}

export class ProviderEventIngestorV2 extends Context.Service<
  ProviderEventIngestorV2,
  ProviderEventIngestorV2Shape
>()("t3/orchestration-v2/ProviderEventIngestor") {}

function compactUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

export const layer: Layer.Layer<ProviderEventIngestorV2, never, EventSinkV2 | IdAllocatorV2> =
  Layer.effect(
    ProviderEventIngestorV2,
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;

      const makeDomainEvent = (
        input: {
          readonly providerSessionId: ProviderSessionId;
          readonly commandId?: CommandId;
          readonly threadId: ThreadId;
          readonly runId?: RunId;
          readonly nodeId?: NodeId;
          readonly rawEventId?: RawEventId;
          readonly event: ProviderAdapterV2Event;
        },
        payloadInput: {
          readonly type: OrchestrationV2DomainEvent["type"];
          readonly payload: OrchestrationV2DomainEvent["payload"];
          readonly runId?: RunId | null;
          readonly nodeId?: NodeId | null;
        },
      ) =>
        Effect.gen(function* () {
          const eventId = yield* idAllocator.allocate.event({
            threadId: input.threadId,
            providerSessionId: input.providerSessionId,
          });
          const occurredAt = yield* DateTime.now;
          return yield* Schema.decodeUnknownEffect(OrchestrationV2DomainEvent)(
            compactUndefined({
              id: eventId,
              type: payloadInput.type,
              threadId: input.threadId,
              runId: payloadInput.runId ?? input.runId,
              nodeId: payloadInput.nodeId ?? input.nodeId,
              provider: input.event.provider,
              rawEventId: input.rawEventId,
              occurredAt,
              payload: payloadInput.payload,
            }),
          );
        });

      const normalize: ProviderEventIngestorV2Shape["normalize"] = (input) =>
        Effect.gen(function* () {
          switch (input.event.type) {
            case "provider_session.updated":
              return [
                yield* makeDomainEvent(input, {
                  type: "provider-session.updated",
                  payload: input.event.providerSession,
                }),
              ];
            case "provider_thread.updated":
              return [
                yield* makeDomainEvent(input, {
                  type: "provider-thread.updated",
                  payload: input.event.providerThread,
                }),
              ];
            case "provider_turn.updated":
              return [
                yield* makeDomainEvent(input, {
                  type: "provider-turn.updated",
                  payload: input.event.providerTurn,
                  nodeId: input.event.providerTurn.nodeId,
                }),
              ];
            case "node.updated":
              return [
                yield* makeDomainEvent(input, {
                  type: "node.updated",
                  payload: input.event.node,
                  runId: input.event.node.runId,
                  nodeId: input.event.node.id,
                }),
              ];
            case "message.updated":
              return [
                yield* makeDomainEvent(input, {
                  type: "message.updated",
                  payload: input.event.message,
                  runId: input.event.message.runId,
                  nodeId: input.event.message.nodeId,
                }),
              ];
            case "turn_item.updated":
              return [
                yield* makeDomainEvent(input, {
                  type: "turn-item.updated",
                  payload: input.event.turnItem,
                  runId: input.event.turnItem.runId,
                  nodeId: input.event.turnItem.nodeId,
                }),
              ];
            case "runtime_request.updated":
              return [
                yield* makeDomainEvent(input, {
                  type: "runtime-request.updated",
                  payload: input.event.runtimeRequest,
                  nodeId: input.event.runtimeRequest.nodeId,
                }),
              ];
            case "plan.updated":
              return [
                yield* makeDomainEvent(input, {
                  type: "plan.updated",
                  payload: input.event.plan,
                  runId: input.event.plan.runId,
                  nodeId: input.event.plan.nodeId,
                }),
              ];
            case "turn.terminal":
              return [];
          }
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderEventNormalizeError({
                providerSessionId: input.providerSessionId,
                threadId: input.threadId,
                providerEvent: input.event,
                cause,
              }),
          ),
        );

      return ProviderEventIngestorV2.of({
        normalize,
        ingestNormalized: (input) =>
          Effect.gen(function* () {
            const events = yield* normalize(input);
            if (events.length === 0) {
              return [];
            }
            return yield* eventSink
              .write({
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                events,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderEventPublishError({
                      providerSessionId: input.providerSessionId,
                      eventCount: events.length,
                      cause,
                    }),
                ),
              );
          }),
      });
    }),
  );
