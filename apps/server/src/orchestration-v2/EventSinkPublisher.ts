// @effect-diagnostics anyUnknownInErrorContext:off
import {
  CommandId,
  type OrchestrationV2Run,
  OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  OrchestrationV2StoredEvent,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  NodeId,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { replayAndBufferProjectedLiveEvents } from "./LiveStreamBudget.ts";
import type { UnsequencedProjectEvent } from "../persistence/OrchestrationEventStore.ts";
import { projectDomainEventForWire } from "./WireProjection.ts";
import { makeRunOutcomeRecorder, type RunOutcome } from "./RunMetrics.ts";

import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import type { EventSinkV2Shape } from "./EventSinkContracts.ts";
export * from "./EventSinkContracts.ts";

export const makeEventSinkPublisher = (deps: {
  sql: SqlClient.SqlClient;
  commandReceipts: CommandReceiptStore.CommandReceiptStoreV2Shape;
  effectOutbox: EffectOutbox.EffectOutboxV2Shape;
  eventStore: EventStore.EventStoreV2Shape;
  projectionStore: ProjectionStore.ProjectionStoreV2Shape;
  turnItemPositions: TurnItemPositionStore.TurnItemPositionStoreV2Shape;
  publishLane: Semaphore.Semaphore;
  liveEvents: PubSub.PubSub<OrchestrationV2StoredEvent>;
}) => {
  const { sql, commandReceipts, effectOutbox, eventStore, projectionStore, turnItemPositions, publishLane } = deps;
    const liveEvents = deps.liveEvents;
    const liveEventsByType = new Map<
      OrchestrationV2DomainEvent["type"],
      PubSub.PubSub<OrchestrationV2StoredEvent>
    >();
    const publishLiveEvents =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (events: ReadonlyArray<OrchestrationV2StoredEvent>) {
        yield* PubSub.publishAll(liveEvents, events);
        for (const [type, pubsub] of liveEventsByType) {
          yield* PubSub.publishAll(
            pubsub,
            events.filter((stored) => stored.event.type === type),
          );
        }
      });
    const runOutcomes = makeRunOutcomeRecorder((threadId) =>
      // One payload row; unlike the shell, it still resolves a deleted child thread.
      projectionStore
        .getThread(threadId)
        .pipe(Effect.map((thread) => thread.lineage.relationshipToParent === "subagent")),
    );
    // Recorded before publication, so an interrupted publish cannot lose a committed outcome.
    const publishStoredEvents = (
      events: ReadonlyArray<OrchestrationV2StoredEvent>,
      outcomes: ReadonlyArray<RunOutcome>,
    ) =>
      runOutcomes
        .record(outcomes)
        .pipe(
          Effect.andThen(eventStore.publishCommitted(events)),
          Effect.andThen(publishLiveEvents(events)),
        );

    // Serialize commit and publish; reordered publication makes clients drop earlier sequences.
    const commitThenPublish = <A, E, R>(
      transaction: Effect.Effect<A, E, R>,
      publish: (committed: A) => Effect.Effect<void>,
    ) =>
      Effect.uninterruptibleMask((restore) => {
        let holdsLane = false;
        const takeLane = publishLane.take(1).pipe(
          Effect.andThen(
            Effect.sync(() => {
              holdsLane = true;
            }),
          ),
          Effect.uninterruptible,
        );
        // Cancellation may roll back the transaction's work. Once it commits,
        // every subscriber must hear about it before this writer can exit.
        // Otherwise a failed child run can leave its parent's task running.
        return sql
          .withTransaction(Effect.tap(restore(transaction), () => takeLane))
          .pipe(
            Effect.tap(publish),
            Effect.ensuring(
              Effect.suspend(() => (holdsLane ? publishLane.release(1) : Effect.void)),
            ),
          );
      });

    // A user can answer after terminal normalization reads the pending request.
    // Recheck inside the write transaction so stale cleanup cannot erase answers.
    const guardUserInputCancellations =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (events: ReadonlyArray<OrchestrationV2DomainEvent>) {
        const staleRequests = new Set<RuntimeRequestId>();
        const staleNodes = new Set<NodeId>();
        for (const event of events) {
          if (
            event.type !== "runtime-request.updated" ||
            event.payload.kind !== "user_input" ||
            event.payload.status !== "cancelled"
          )
            continue;
          const current = yield* projectionStore.getRuntimeRequest(
            event.threadId,
            event.payload.id,
          );
          if (
            current?.status !== "pending" ||
            current.kind !== "user_input" ||
            current.providerTurnId !== event.payload.providerTurnId ||
            current.responseCapability.type === "message"
          ) {
            staleRequests.add(event.payload.id);
            staleNodes.add(event.payload.nodeId);
          }
        }
        return events.filter((event) => {
          switch (event.type) {
            case "runtime-request.updated":
              return event.payload.status !== "cancelled" || !staleRequests.has(event.payload.id);
            case "node.updated":
              return event.payload.status !== "cancelled" || !staleNodes.has(event.payload.id);
            case "turn-item.updated":
              return (
                event.payload.type !== "user_input_request" ||
                event.payload.status !== "cancelled" ||
                !staleRequests.has(event.payload.requestId)
              );
            default:
              return true;
          }
        });
      });

    const normalizeEvents = (events: ReadonlyArray<OrchestrationV2DomainEvent>) => {
      const runOrdinals = new Map(
        events.flatMap((event) =>
          event.type === "run.created" || event.type === "run.updated"
            ? [[event.payload.id, event.payload.ordinal] as const]
            : [],
        ),
      );
      return Effect.forEach(
        events,
        (event): Effect.Effect<OrchestrationV2DomainEvent, unknown> =>
          event.type === "turn-item.updated"
            ? turnItemPositions
                .normalize(
                  event.payload,
                  event.payload.runId === null ? undefined : runOrdinals.get(event.payload.runId),
                )
                .pipe(Effect.map((payload) => ({ ...event, payload })))
            : Effect.succeed(event),
        { concurrency: 1 },
      );
    };

    const applyStoredEvents =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(function* (storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>) {
        yield* Effect.forEach(storedEvents, (stored) => projectionStore.apply(stored.event), {
          concurrency: 1,
        });
        const sequence = storedEvents.at(-1)?.sequence;
        if (sequence !== undefined) {
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`
            INSERT INTO orchestration_v2_projection_metadata (
              projection_name,
              schema_version,
              last_sequence,
              updated_at
            )
            VALUES (
              'thread-projections',
              ${ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION},
              ${sequence},
              ${now}
            )
            ON CONFLICT(projection_name)
            DO UPDATE SET
              schema_version = excluded.schema_version,
              last_sequence = excluded.last_sequence,
              updated_at = excluded.updated_at
          `;
        }
        // Read lineage here, on the connection this transaction holds; see makeRunOutcomeRecorder.
        return yield* runOutcomes.prepare(storedEvents);
      });

    // The enclosing write or commit span already traces this per-event projection merge.
    const updateDelegatedCompletionOnly = Effect.fnUntraced(function* (
      events: ReadonlyArray<OrchestrationV2DomainEvent>,
      includesRun: (runId: RunId) => boolean,
    ) {
      return yield* Effect.forEach(events, (event) =>
        Effect.gen(function* () {
          if (event.type !== "run.updated" || !includesRun(event.payload.id)) return event;
          const { runs } = yield* projectionStore.getThreadRecords(event.threadId, ["runs"], {
            runIds: [event.payload.id],
          });
          const current = runs[0];
          return current === undefined
            ? event
            : {
                ...event,
                payload: { ...current, delegatedCompletion: event.payload.delegatedCompletion },
              };
        }),
      );
    });

    const writeEffect = Effect.fn("orchestrationV2.EventSink.write")(function* (
      input: Parameters<EventSinkV2Shape["writeWithEffects"]>[0],
    ) {
      yield* Effect.annotateCurrentSpan({
        "orchestration_v2.command_id": input.commandId ?? null,
        "orchestration_v2.event_count": input.events.length,
        "orchestration_v2.thread_id": input.events[0]?.threadId ?? null,
      });

      const { committed } = yield* commitThenPublish(
        Effect.gen(function* () {
          // Check ownership in the same transaction that claims the native session.
          const imported = input.unlessNativeThreadOwned;
          if (imported?.nativeThreadRef != null) {
            const owners = yield* sql`
              SELECT provider_thread_id
              FROM orchestration_v2_projection_provider_threads
              WHERE driver = ${imported.driver}
                AND provider_instance_id = ${imported.providerInstanceId}
                AND thread_id IS NOT ${imported.appThreadId}
                AND json_extract(payload_json, '$.nativeThreadRef.nativeId') = ${imported.nativeThreadRef.nativeId}
              LIMIT 1
            `;
            if (owners.length > 0) return { committed: [], outcomes: [] };
          }
          // Checkpoint capture can finish after a cohort writer reads its parent run.
          // Merge in this transaction so the event log and projection keep that completion.
          const events = input.updateDelegatedCompletionOnly
            ? yield* updateDelegatedCompletionOnly(input.events, () => true)
            : input.events;
          const normalized = yield* normalizeEvents(
            input.guardPendingUserInputCancellations === true
              ? yield* guardUserInputCancellations(events)
              : events,
          );
          const committed = yield* eventStore.append({
            ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
            events: normalized,
          });
          const outcomes = yield* applyStoredEvents(committed);
          yield* effectOutbox.enqueue(input.effects);
          return { committed, outcomes };
        }).pipe(Effect.withTracerEnabled(false)),
        ({ committed, outcomes }) =>
          Effect.gen(function* () {
            if (input.effects.length > 0) {
              yield* effectOutbox.notifyAvailable(input.effects.length);
            }
            yield* publishStoredEvents(committed, outcomes);
          }),
      );
      return committed;
    });


  return { liveEvents, liveEventsByType, publishStoredEvents, publishLane, commitThenPublish, normalizeEvents, updateDelegatedCompletionOnly, writeEffect, applyStoredEvents, guardUserInputCancellations };
};
