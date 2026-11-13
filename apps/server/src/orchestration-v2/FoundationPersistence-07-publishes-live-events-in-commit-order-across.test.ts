// @effect-diagnostics nodeBuiltinImport:off -- fixtures and tests use Node builtins

import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { vi } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import * as DatabaseStorage from "../persistence/DatabaseStorage.ts";
import * as ServerSettings from "../serverSettings.ts";
import { LIVE_STREAM_MAX_ITEMS, LiveStreamBufferError } from "./LiveStreamBudget.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionReplay from "./testkit/ProjectionReplay.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

import {
  encodeJson,
  isLiveStreamBufferError,
  layerCommandReceiptStoreProvided,
  layerDatabase,
  layerEffectOutboxProvided,
  layerEventSinkProvided,
  layerEventStoreProvided,
  layerIsolatedOutbox,
  layerProjectionMaintenanceProvided,
  layerProjectionReplayProvided,
  layerProjectionStoreProvided,
  layerStoresProvided,
  layerTest,
  makeThread,
  modelSelection,
  providerDriver,
  providerInstanceId,
  seedCompaction,
  threadCreatedEvent,
} from "./FoundationPersistence-fixtures.testkit.ts";

it.effect("publishes live events in commit order across concurrent writers", () =>
  Effect.gen(function* () {
    const firstCommitted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const layerPausingOutbox = Layer.effect(
      EffectOutbox.EffectOutboxV2,
      Effect.gen(function* () {
        const delegate = yield* EffectOutbox.EffectOutboxV2;
        return EffectOutbox.EffectOutboxV2.of({
          ...delegate,
          notifyAvailable: (count) =>
            Deferred.succeed(firstCommitted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirst)),
              Effect.andThen(delegate.notifyAvailable(count)),
            ),
        });
      }),
    ).pipe(Layer.provide(layerEffectOutboxProvided));
    const layerEventSink = EventSink.layerFromStores.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerStoresProvided,
          layerPausingOutbox,
          layerCommandReceiptStoreProvided,
          ProjectStore.layer.pipe(Layer.provide(layerDatabase)),
          TurnItemPositionStore.layer.pipe(Layer.provide(layerDatabase)),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const first = makeThread(ThreadId.make("thread:foundation-publish-order:first"), now);
      const second = makeThread(ThreadId.make("thread:foundation-publish-order:second"), now);
      const published = yield* eventSink
        .stream({ afterSequence: yield* eventSink.latestSequence() })
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped({ startImmediately: true }));

      const firstWrite = yield* eventSink
        .writeWithEffects({
          events: [
            threadCreatedEvent({ id: "event:foundation-publish-order:first", thread: first, now }),
          ],
          effects: [
            {
              id: "effect:foundation-publish-order:first",
              commandId: CommandId.make("command:foundation-publish-order:first"),
              threadId: first.id,
              request: { type: "terminal.cleanup" },
            },
          ],
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(firstCommitted);
      const secondWrite = yield* eventSink
        .write({
          events: [
            threadCreatedEvent({
              id: "event:foundation-publish-order:second",
              thread: second,
              now,
            }),
          ],
        })
        .pipe(
          Effect.provideService(Scheduler.MaxOpsBeforeYield, Number.POSITIVE_INFINITY),
          Effect.forkScoped,
        );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(firstWrite);
      yield* Fiber.join(secondWrite);

      const sequences = Array.from(yield* Fiber.join(published), (stored) => stored.sequence);
      assert.deepEqual(
        sequences,
        [...sequences].sort((left, right) => left - right),
      );
    }).pipe(Effect.provide(layerEventSink));
  }).pipe(Effect.provide(layerDatabase)),
);

it.effect.each(["events", "receipts"] as const)(
  "allows writes while compaction waits for the reader to discover obsolete %s",
  (kind) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "compaction-reader-" });
      const database = SqlitePersistence.layerFromPath(path.join(directory, "statev2.sqlite"));
      const maintenanceLayer = ProjectionMaintenance.layer.pipe(Layer.provideMerge(database));
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          INSERT INTO orchestration_v2_legacy_imports (
            thread_id, source_updated_at, shell_imported_at, transcript_imported_at,
            imported_message_count, last_error
          ) VALUES ('imported', ${now}, ${now}, ${now}, 1, NULL)
        `;
        for (const threadId of ["imported", "pending"]) {
          if (kind === "events") {
            yield* sql`
              INSERT INTO orchestration_events (
                event_id, aggregate_kind, stream_id, stream_version, event_type,
                occurred_at, actor_kind, payload_json, metadata_json, application_event_version
              ) VALUES (
                ${threadId}, 'thread', ${threadId}, 1, 'thread.message-appended',
                ${now}, 'user', '{}', '{}', 1
              )
            `;
          } else {
            yield* sql`
              INSERT INTO orchestration_command_receipts (
                command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence,
                status, command_type
              ) VALUES (${threadId}, 'thread', ${threadId}, ${now}, 1, 'accepted', 'legacy')
            `;
          }
        }
        yield* sql`CREATE TABLE concurrent_writes (value TEXT)`;
        const readerHeld = yield* Deferred.make<void>();
        const releaseReader = yield* Deferred.make<void>();
        const discoveryStarted = yield* Deferred.make<Tracer.Span>();
        const observeDiscovery: Statement.Transformer = (statement, _sql, _fiber, span) => {
          const [query] = statement.compile();
          const pageQuery =
            kind === "events" ? /^\s*SELECT\s+event\.sequence/ : /^\s*SELECT\s+receipt\.rowid/;
          return pageQuery.test(query)
            ? Deferred.succeed(discoveryStarted, span).pipe(
                Effect.andThen(Deferred.await(readerHeld)),
                Effect.as(statement),
              )
            : Effect.succeed(statement);
        };
        const compacted = yield* Deferred.make<void>();
        const compaction = yield* maintenance.pruneEventStore().pipe(
          Effect.provideService(Statement.CurrentTransformer, observeDiscovery),
          Effect.provideService(Statement.SpanPropagationEnabled, true),
          Effect.tap(() => Deferred.succeed(compacted, undefined)),
          Effect.forkChild,
        );
        const discoverySpan = yield* Deferred.await(discoveryStarted);
        // Let the initial bounds read finish before holding the reader for this page.
        const reader = yield* sql
          .withTransaction(
            Deferred.succeed(readerHeld, undefined).pipe(
              Effect.andThen(Deferred.await(releaseReader)),
            ),
          )
          .pipe(NodeSqliteClient.readOnly, Effect.forkChild);
        yield* Deferred.await(readerHeld);
        yield* sql`INSERT INTO concurrent_writes VALUES ('committed')`;
        assert.isFalse(yield* Deferred.isDone(compacted));
        assert.deepEqual(yield* sql`SELECT value FROM concurrent_writes`, [{ value: "committed" }]);
        if (kind === "events") {
          yield* sql`
            INSERT INTO orchestration_events (
              event_id, aggregate_kind, stream_id, stream_version, event_type,
              occurred_at, actor_kind, payload_json, metadata_json, application_event_version
            ) VALUES (
              'after-bound', 'thread', 'imported', 2, 'thread.message-appended',
              ${now}, 'user', '{}', '{}', 1
            )
          `;
        } else {
          yield* sql`
            INSERT INTO orchestration_command_receipts (
              command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence,
              status, command_type
            ) VALUES ('after-bound', 'thread', 'imported', ${now}, 1, 'accepted', 'legacy')
          `;
        }
        yield* Deferred.succeed(releaseReader, undefined);
        yield* Fiber.join(reader);
        const result = yield* Fiber.join(compaction);
        assert.equal(discoverySpan.attributes.get("db.connection"), "reader");
        assert.equal(result.deletedEventCount, kind === "events" ? 1 : 0);
        assert.equal(result.deletedReceiptCount, kind === "receipts" ? 1 : 0);
        const retained =
          kind === "events"
            ? yield* sql`SELECT event_id AS id FROM orchestration_events ORDER BY sequence`
            : yield* sql`SELECT command_id AS id FROM orchestration_command_receipts ORDER BY rowid`;
        assert.deepEqual(retained, [{ id: "pending" }, { id: "after-bound" }]);
      }).pipe(Effect.provide(maintenanceLayer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("routes projection node lookups to the reader connection", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "projection-reader-" });
    const database = SqlitePersistence.layerFromPath(path.join(directory, "statev2.sqlite"));
    const projectionLayer = ProjectionStore.layer.pipe(Layer.provideMerge(database));
    yield* Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const nodeId = NodeId.make("node:reader-routing");
      const node = {
        id: nodeId,
        threadId: ThreadId.make("thread:reader-routing"),
        runId: null,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: "subagent" as const,
        status: "running" as const,
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      const spans: Array<Tracer.Span> = [];
      const observe: Statement.Transformer = (statement, _sql, _fiber, span) => {
        const [query] = statement.compile();
        if (/orchestration_v2_projection_nodes WHERE node_id/.test(query)) {
          spans.push(span);
        }
        return Effect.succeed(statement);
      };
      yield* Effect.gen(function* () {
        assert.isFalse(yield* projections.isNodeStored(node));
      }).pipe(
        Effect.provideService(Statement.CurrentTransformer, observe),
        Effect.provideService(Statement.SpanPropagationEnabled, true),
      );
      assert.equal(spans.length, 1);
      assert.isTrue(
        spans.every((span) => span.attributes.get("db.connection") === "reader"),
        JSON.stringify(spans.map((span) => span.attributes.get("db.connection"))),
      );
    }).pipe(Effect.provide(projectionLayer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("loads a shell snapshot while the writer connection is occupied", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "shell-reader-" });
    const database = SqlitePersistence.layerFromPath(path.join(directory, "statev2.sqlite"));
    const projectionLayer = ProjectionStore.layer.pipe(Layer.provideMerge(database));
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const writer = yield* sql
        .withTransaction(
          sql`SELECT 1`.pipe(
            Effect.andThen(Deferred.succeed(held, undefined)),
            Effect.andThen(Deferred.await(release)),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const snapshot = yield* projections.getShellSnapshot();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(writer);
      assert.deepEqual(snapshot.threads, []);
    }).pipe(Effect.provide(projectionLayer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each(["cancel transaction", "fail transaction", "cancel publication"] as const)(
  "preserves event consistency and allows later writes after %s",
  (scenario) =>
    Effect.gen(function* () {
      const paused = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const committed = scenario === "cancel publication";
      const pause = Deferred.succeed(paused, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const layerPausingOutbox = Layer.effect(
        EffectOutbox.EffectOutboxV2,
        Effect.gen(function* () {
          const delegate = yield* EffectOutbox.EffectOutboxV2;
          return EffectOutbox.EffectOutboxV2.of({
            ...delegate,
            enqueue: (effects) =>
              delegate
                .enqueue(effects)
                .pipe(
                  Effect.andThen(!committed && effects.length > 0 ? pause : Effect.void),
                  Effect.andThen(
                    scenario === "fail transaction" && effects.length > 0
                      ? Effect.die("Injected transaction failure")
                      : Effect.void,
                  ),
                ),
            notifyAvailable: (count) =>
              (committed ? pause : Effect.void).pipe(
                Effect.andThen(delegate.notifyAvailable(count)),
              ),
          });
        }),
      ).pipe(Layer.provide(layerEffectOutboxProvided));
      const layerEventSink = EventSink.layerFromStores.pipe(
        Layer.provide(
          Layer.mergeAll(
            layerStoresProvided,
            layerPausingOutbox,
            layerCommandReceiptStoreProvided,
            ProjectStore.layer.pipe(Layer.provide(layerDatabase)),
            TurnItemPositionStore.layer.pipe(Layer.provide(layerDatabase)),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const eventSink = yield* EventSink.EventSinkV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const now = yield* DateTime.now;
        const first = makeThread(ThreadId.make("thread:interrupted-publish:first"), now);
        const marker = makeThread(ThreadId.make("thread:interrupted-publish:marker"), now);
        const published = yield* eventSink
          .stream({ afterSequence: yield* eventSink.latestSequence() })
          .pipe(
            Stream.takeUntil((stored) => stored.event.threadId === marker.id),
            Stream.runCollect,
            Effect.forkScoped({ startImmediately: true }),
          );
        const writer = yield* eventSink
          .writeWithEffects({
            events: [
              threadCreatedEvent({ id: "event:interrupted-publish:first", thread: first, now }),
            ],
            effects: [
              {
                id: "effect:interrupted-publish:first",
                commandId: CommandId.make("command:interrupted-publish:first"),
                threadId: first.id,
                request: { type: "terminal.cleanup" },
              },
            ],
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(paused);
        if (scenario !== "fail transaction") writer.interruptUnsafe();
        if (scenario !== "cancel transaction") yield* Deferred.succeed(release, undefined);
        assert.equal((yield* Fiber.await(writer))._tag, "Failure");
        assert.equal(
          (yield* projections.getThreadShell(first.id))?.id ?? null,
          committed ? first.id : null,
        );
        assert.equal(
          Option.isSome(yield* outbox.get("effect:interrupted-publish:first")),
          committed,
        );
        yield* eventSink.write({
          events: [
            threadCreatedEvent({ id: "event:interrupted-publish:marker", thread: marker, now }),
          ],
        });
        assert.deepEqual(
          Array.from(yield* Fiber.join(published), (stored) => stored.event.threadId),
          committed ? [first.id, marker.id] : [marker.id],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(layerEventSink, layerStoresProvided, layerEffectOutboxProvided),
        ),
      );
    }).pipe(Effect.provide(layerDatabase)),
);
