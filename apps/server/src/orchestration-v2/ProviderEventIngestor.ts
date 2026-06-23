import {
  NodeId,
  CommandId,
  OrchestrationV2DomainEvent,
  OrchestrationV2StoredEvent,
  type OrchestrationV2Run,
  ProviderInstanceId,
  ProviderSessionId,
  RawEventId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { EventSinkV2 } from "./EventSink.ts";
import { IdAllocatorV2 } from "./IdAllocator.ts";
import { ProviderAdapterV2Event } from "./ProviderAdapter.ts";
import { makeProviderFailureTurnItem } from "./ProviderFailure.ts";

export class ProviderEventNormalizeError extends Schema.TaggedErrorClass<ProviderEventNormalizeError>()(
  "ProviderEventNormalizeError",
  {
    providerSessionId: ProviderSessionId,
    threadId: ThreadId,
    providerEvent: ProviderAdapterV2Event,
    cause: Schema.optional(Schema.Defect()),
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
    cause: Schema.optional(Schema.Defect()),
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

export interface ProviderEventIngestInput {
  readonly providerSessionId: ProviderSessionId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly commandId?: CommandId;
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly nodeId?: NodeId;
  readonly rawEventId?: RawEventId;
  readonly event: ProviderAdapterV2Event;
}

export interface ProviderEventIngestorV2Shape {
  readonly normalize: (
    input: ProviderEventIngestInput,
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2DomainEvent>, ProviderEventIngestorV2Error>;
  readonly ingestNormalized: (
    input: ProviderEventIngestInput & {
      /**
       * Atomically reject mutable provider state emitted by an attempt that
       * lost ownership while the adapter event was in flight.
       */
      readonly writeIfRunCurrent?: {
        readonly runId: RunId;
        readonly activeAttemptId: RunAttemptId;
        readonly expectedStatus: OrchestrationV2Run["status"];
      };
    },
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2StoredEvent>, ProviderEventIngestorV2Error>;
}

export class ProviderEventIngestorV2 extends Context.Service<
  ProviderEventIngestorV2,
  ProviderEventIngestorV2Shape
>()("t3/orchestration-v2/ProviderEventIngestor/ProviderEventIngestorV2") {}

function compactUndefined<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

const decodeDomainEvent = Schema.decodeUnknownEffect(OrchestrationV2DomainEvent);

export const layer: Layer.Layer<ProviderEventIngestorV2, never, EventSinkV2 | IdAllocatorV2> =
  Layer.effect(
    ProviderEventIngestorV2,
    Effect.gen(function* () {
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;

      const makeDomainEvent = (
        input: ProviderEventIngestInput,
        payloadInput: {
          readonly type: OrchestrationV2DomainEvent["type"];
          readonly payload: OrchestrationV2DomainEvent["payload"];
          readonly threadId?: ThreadId;
          readonly runId?: RunId | null;
          readonly nodeId?: NodeId | null;
        },
      ) =>
        Effect.gen(function* () {
          const threadId = payloadInput.threadId ?? input.threadId;
          const eventId = yield* idAllocator.allocate.event({
            threadId,
            providerSessionId: input.providerSessionId,
          });
          const occurredAt = yield* DateTime.now;
          return yield* decodeDomainEvent(
            compactUndefined({
              id: eventId,
              type: payloadInput.type,
              threadId,
              runId: payloadInput.runId ?? input.runId,
              nodeId: payloadInput.nodeId ?? input.nodeId,
              driver: input.event.driver,
              providerInstanceId: input.providerInstanceId,
              rawEventId: input.rawEventId,
              occurredAt,
              payload: payloadInput.payload,
            }),
          );
        });

      const normalize: ProviderEventIngestorV2Shape["normalize"] = (input) =>
        Effect.gen(function* () {
          switch (input.event.type) {
            case "app_thread.created":
              return [
                yield* makeDomainEvent(input, {
                  type: "thread.created",
                  threadId: input.event.appThread.id,
                  payload: input.event.appThread,
                }),
              ];
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
                  threadId: input.event.providerThread.appThreadId ?? input.threadId,
                  payload: input.event.providerThread,
                }),
              ];
            case "provider_turn.updated":
              return [
                yield* makeDomainEvent(input, {
                  type: "provider-turn.updated",
                  ...(input.event.threadId === undefined ? {} : { threadId: input.event.threadId }),
                  payload: input.event.providerTurn,
                  nodeId: input.event.providerTurn.nodeId,
                }),
              ];
            case "node.updated":
              return [
                yield* makeDomainEvent(input, {
                  type: "node.updated",
                  threadId: input.event.node.threadId,
                  payload: input.event.node,
                  runId: input.event.node.runId,
                  nodeId: input.event.node.id,
                }),
              ];
            case "subagent.updated":
              return [
                yield* makeDomainEvent(input, {
                  type: "subagent.updated",
                  threadId: input.event.subagent.threadId,
                  payload: input.event.subagent,
                  runId: input.event.subagent.runId,
                  nodeId: input.event.subagent.id,
                }),
              ];
            case "message.updated":
              return [
                yield* makeDomainEvent(input, {
                  type: "message.updated",
                  threadId: input.event.message.threadId,
                  payload: input.event.message,
                  runId: input.event.message.runId,
                  nodeId: input.event.message.nodeId,
                }),
              ];
            case "turn_item.updated":
              return [
                yield* makeDomainEvent(input, {
                  type: "turn-item.updated",
                  threadId: input.event.turnItem.threadId,
                  payload: input.event.turnItem,
                  runId: input.event.turnItem.runId,
                  nodeId: input.event.turnItem.nodeId,
                }),
              ];
            case "runtime_request.updated":
              return [
                yield* makeDomainEvent(input, {
                  type: "runtime-request.updated",
                  ...(input.event.threadId === undefined ? {} : { threadId: input.event.threadId }),
                  payload: input.event.runtimeRequest,
                  nodeId: input.event.runtimeRequest.nodeId,
                }),
              ];
            case "plan.updated":
              return [
                yield* makeDomainEvent(input, {
                  type: "plan.updated",
                  threadId: input.event.plan.threadId,
                  payload: input.event.plan,
                  runId: input.event.plan.runId,
                  nodeId: input.event.plan.nodeId,
                }),
              ];
            case "turn.terminal":
              if (input.event.status !== "failed") {
                return [];
              }
              const occurredAt = yield* DateTime.now;
              return [
                yield* makeDomainEvent(input, {
                  type: "turn-item.updated",
                  payload: makeProviderFailureTurnItem({
                    idAllocator,
                    driver: input.event.driver,
                    threadId: input.threadId,
                    runId: input.runId ?? null,
                    nodeId: input.nodeId ?? null,
                    providerThreadId: input.event.providerThreadId,
                    providerTurnId: input.event.providerTurnId,
                    itemOrdinal: input.event.failureItemOrdinal,
                    failure: input.event.failure,
                    occurredAt,
                  }),
                }),
              ];
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
            const mapWriteError = (cause: unknown) =>
              new ProviderEventPublishError({
                providerSessionId: input.providerSessionId,
                eventCount: events.length,
                cause,
              });
            if (input.writeIfRunCurrent === undefined) {
              return yield* eventSink
                .write({
                  ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                  events,
                })
                .pipe(Effect.mapError(mapWriteError));
            }
            const result = yield* eventSink
              .writeIfRunCurrent({
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                threadId: input.threadId,
                ...input.writeIfRunCurrent,
                events,
              })
              .pipe(Effect.mapError(mapWriteError));
            return result.storedEvents;
          }),
      });
    }),
  );
