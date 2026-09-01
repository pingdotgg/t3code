import {
  NodeId,
  CommandId,
  OrchestrationV2DomainEvent,
  OrchestrationV2StoredEvent,
  type OrchestrationV2Run,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RawEventId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { EventSinkV2 } from "./EventSink.ts";
import { IdAllocatorV2 } from "./IdAllocator.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
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
      /**
       * Atomically reject provider-thread snapshots from an attempt that no
       * longer owns the run or from a run that no longer owns the thread.
       */
      readonly writeIfProviderThreadOwner?: {
        readonly providerThreadId: ProviderThreadId;
        readonly runId: RunId;
        readonly activeAttemptId: RunAttemptId;
        readonly expectedLastRunOrdinal: number;
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

/**
 * Provider-originated activity that should clear explicit settle pins.
 * Pending approval/user-input requests are thread-scoped activity. Provider
 * session status is process-wide and may be persisted onto unrelated attached
 * threads, so it cannot clear a thread's settle pin.
 */
export function isSettledClearingProviderActivity(event: OrchestrationV2DomainEvent): boolean {
  return providerActivityTimestamp(event) !== null;
}

/**
 * Provider payload activity time for synthetic activity-unsettle ordering only.
 * Ordinary provider domain events keep ingestion occurredAt; this clock is used
 * solely for the synthetic thread.unsettled candidate so delayed activity cannot
 * clear a newer pin, without rewriting normal event order timestamps.
 */
export function providerActivityTimestamp(event: OrchestrationV2DomainEvent): DateTime.Utc | null {
  switch (event.type) {
    case "runtime-request.updated":
      // Newly pending blocked-on-you work wakes a settled/active pin. Resolved
      // or cancelled requests and auth refresh do not.
      if (event.payload.status !== "pending" || event.payload.kind === "auth_refresh") {
        return null;
      }
      return event.payload.createdAt;
    default:
      return null;
  }
}

const decodeDomainEvent = Schema.decodeUnknownEffect(OrchestrationV2DomainEvent);

export const layer: Layer.Layer<
  ProviderEventIngestorV2,
  never,
  EventSinkV2 | IdAllocatorV2 | ProjectionStoreV2
> = Layer.effect(
  ProviderEventIngestorV2,
  Effect.gen(function* () {
    const eventSink = yield* EventSinkV2;
    const idAllocator = yield* IdAllocatorV2;
    const projectionStore = yield* ProjectionStoreV2;

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
        // Always stamp ordinary provider events at ingestion time.
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
                  ...(input.event.retry === undefined ? {} : { retry: input.event.retry }),
                  ...(input.event.retryStartedAt === undefined
                    ? {}
                    : { retryStartedAt: input.event.retryStartedAt }),
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

    const prependActivityUnsettle = (input: {
      readonly providerSessionId: ProviderSessionId;
      readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    }) =>
      Effect.gen(function* () {
        const { events } = input;
        if (events.length === 0) {
          return events;
        }
        if (events.some((event) => event.type === "thread.unsettled")) {
          return events;
        }
        const activityByThread = new Map<ThreadId, OrchestrationV2DomainEvent>();
        for (const event of events) {
          if (!isSettledClearingProviderActivity(event)) continue;
          if (!activityByThread.has(event.threadId)) {
            activityByThread.set(event.threadId, event);
          }
        }
        if (activityByThread.size === 0) {
          return events;
        }

        const unsettled: Array<OrchestrationV2DomainEvent> = [];
        for (const [threadId, activityEvent] of activityByThread) {
          // Ordering uses provider payload time only on this synthetic event.
          const activityAt = providerActivityTimestamp(activityEvent);
          if (activityAt === null) {
            continue;
          }
          // Always emit a candidate for qualifying activity. Do not skip based
          // on a pre-TX projection read: a concurrent settle can land between
          // read and write, and only the transactional reducer may decide.
          // Only a definitive missing thread skips the candidate. Other read
          // failures must surface so callers can retry rather than silently
          // store activity without an unsettle attempt.
          const projectionOption = yield* projectionStore.getThreadProjection(threadId).pipe(
            Effect.map(Option.some),
            Effect.catchTags({
              ProjectionStoreThreadNotFoundError: () => Effect.succeed(Option.none()),
            }),
          );
          if (Option.isNone(projectionOption)) {
            continue;
          }
          const projection = projectionOption.value;
          const eventId = yield* idAllocator.allocate.event({
            threadId,
            providerSessionId: input.providerSessionId,
          });
          // Payload may be a stale full-thread snapshot; reducers apply only
          // settlement fields so concurrent metadata/archive stays intact.
          unsettled.push(
            yield* decodeDomainEvent({
              id: eventId,
              type: "thread.unsettled",
              threadId,
              providerInstanceId:
                activityEvent.providerInstanceId ?? projection.thread.providerInstanceId,
              occurredAt: activityAt,
              payload: {
                ...projection.thread,
                settledOverride: null,
                settledAt: null,
                settledOverrideAt: null,
                updatedAt: activityAt,
              },
            }),
          );
        }
        return unsettled.length === 0 ? events : [...unsettled, ...events];
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderEventPublishError({
              providerSessionId: input.providerSessionId,
              eventCount: input.events.length,
              cause,
            }),
        ),
      );

    return ProviderEventIngestorV2.of({
      normalize,
      ingestNormalized: (input) =>
        Effect.gen(function* () {
          const normalized = yield* normalize(input);
          if (normalized.length === 0) {
            return [];
          }
          const events = yield* prependActivityUnsettle({
            providerSessionId: input.providerSessionId,
            events: normalized,
          });
          const mapWriteError = (cause: unknown) =>
            new ProviderEventPublishError({
              providerSessionId: input.providerSessionId,
              eventCount: events.length,
              cause,
            });
          if (input.writeIfProviderThreadOwner !== undefined) {
            const ownerResult = yield* eventSink
              .writeIfProviderThreadOwner({
                ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
                ...input.writeIfProviderThreadOwner,
                events,
              })
              .pipe(Effect.mapError(mapWriteError));
            return ownerResult.storedEvents;
          }
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
