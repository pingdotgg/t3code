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

it.effect("discovers on the reader worker and deletes on the writer", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filename = path.join(yield* fs.makeTempDirectoryScoped(), "fixture.sqlite");
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedCompaction();
      // Establish the reader before recording main-thread statements.
      yield* sql`SELECT 1`.pipe(NodeSqliteClient.readOnly);
      const reads: string[] = [];
      const writes: string[] = [];
      const all = NodeSqlite.StatementSync.prototype.all;
      const run = NodeSqlite.StatementSync.prototype.run;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const readSpy = vi
            .spyOn(NodeSqlite.StatementSync.prototype, "all")
            .mockImplementation(function (this: NodeSqlite.StatementSync, ...params) {
              reads.push(this.sourceSQL);
              return all.apply(this, params);
            });
          const writeSpy = vi
            .spyOn(NodeSqlite.StatementSync.prototype, "run")
            .mockImplementation(function (this: NodeSqlite.StatementSync, ...params) {
              writes.push(this.sourceSQL);
              return run.apply(this, params);
            });
          return { readSpy, writeSpy };
        }),
        ({ readSpy, writeSpy }) =>
          Effect.sync(() => {
            readSpy.mockRestore();
            writeSpy.mockRestore();
          }),
      );
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const result = yield* maintenance.pruneEventStore();
      assert.equal(result.deletedEventCount, 150);
      assert.equal(result.deletedReceiptCount, 100);
      // Only the in-transaction check for rows appended during the pass reads on the writer.
      assert.deepEqual(
        reads.filter((query) => /\bSELECT\b/.test(query) && !query.includes("AS prompt_sequence")),
        [],
      );
      assert(writes.some((query) => query.includes("DELETE FROM orchestration_events")));
      assert(writes.some((query) => query.includes("DELETE FROM orchestration_command_receipts")));
    }).pipe(
      Effect.provide(
        ProjectionMaintenance.layer.pipe(
          Layer.provideMerge(SqlitePersistence.layerFromPath(filename)),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("paces scheduled compaction while preserving retention state and fixed scan bounds", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const clock = yield* Clock.Clock;
    yield* seedCompaction();
    const completed = yield* Deferred.make<void>();
    const pauseStarted = yield* Deferred.make<void>();
    let activeNanos = 0n;
    let eventPages = 0;
    const pauses: number[] = [];
    const compactionSpans: Tracer.Span[] = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        if (span.name === "ProjectionMaintenance.pruneEventStore") compactionSpans.push(span);
        const end = span.end.bind(span);
        span.end = (time, exit) => {
          end(time, exit);
          const query = span.attributes.get("db.query.text");
          if (typeof query !== "string" || !query.includes("LIMIT")) return;
          if (query.includes("FROM orchestration_events AS event")) {
            eventPages++;
          } else if (!query.includes("FROM orchestration_command_receipts AS receipt")) return;
          // Model a page exceeding the active budget, without wall-clock sleeps.
          activeNanos += 30_000_000n;
        };
        return span;
      },
    });
    yield* Effect.gen(function* () {
      yield* DatabaseStorage.DatabaseStorage;
      yield* TestClock.adjust("1 minute");
      yield* Effect.raceFirst(Deferred.await(pauseStarted), Deferred.await(completed));
      yield* TestClock.adjust("269 millis");
      assert.equal(eventPages, 1);
      assert.deepEqual(pauses, [270]);
      assert.deepEqual(
        compactionSpans.map((span) => span.status._tag),
        ["Started"],
      );
      // Foreground commits must not extend the compactor's initial scan bounds.
      yield* sql`INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES ('after-start', 'thread', 'thread', 152, 'thread.visited', '2026-10-17', 'server', '{}', '{}', 2)`;
      yield* sql`INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, command_type
        ) VALUES ('after-start', 'thread', 'imported', '2026-10-17', 0, 'accepted', 'legacy')`;
      yield* TestClock.adjust("10 seconds");
      yield* Deferred.await(completed);
    }).pipe(
      Effect.provide(
        DatabaseStorage.layer.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "compaction-" })),
          Layer.provide(NodeServices.layer),
        ),
      ),
      Effect.withTracer(tracer),
      Effect.provideService(Clock.Clock, {
        ...clock,
        monotonicTimeNanos: Effect.sync(() => activeNanos),
        sleep: (duration) => {
          const millis = Duration.toMillis(duration);
          if (millis < 60_000) {
            pauses.push(millis);
            Deferred.doneUnsafe(pauseStarted, Effect.void);
          } else if (millis === 6 * 60 * 60_000) {
            Deferred.doneUnsafe(completed, Effect.void);
          }
          return clock.sleep(duration);
        },
      }),
    );
    assert.deepEqual(pauses, Array(8).fill(270));
    assert.deepEqual(
      compactionSpans.map((span) => span.status._tag),
      ["Ended"],
    );
    // 151 stopped being the stream head when 152 committed mid-pass; 152 is past the bound.
    assert.deepEqual(yield* sql`SELECT sequence FROM orchestration_events ORDER BY sequence`, [
      { sequence: 152 },
    ]);
    assert.deepEqual(yield* sql`SELECT command_id FROM orchestration_command_receipts`, [
      { command_id: "after-start" },
    ]);
  }).pipe(Effect.scoped, Effect.provide(layerTest)),
);
