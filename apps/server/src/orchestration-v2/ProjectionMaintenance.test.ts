import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import { vi } from "vite-plus/test";

import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const maintenanceLayer = ProjectionMaintenance.layer.pipe(
  Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
);

const seed = (receiptCount = 101) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_events (
    sequence INTEGER PRIMARY KEY, application_event_version INTEGER, aggregate_kind TEXT,
    stream_id TEXT, event_type TEXT, payload_json TEXT
  )`;
    yield* sql`CREATE TABLE orchestration_command_receipts (
    command_id TEXT PRIMARY KEY, command_type TEXT, aggregate_kind TEXT, aggregate_id TEXT
  )`;
    yield* sql`CREATE TABLE orchestration_v2_legacy_imports (
    thread_id TEXT PRIMARY KEY, transcript_imported_at TEXT
  )`;
    yield* sql`INSERT INTO orchestration_v2_legacy_imports VALUES ('imported', '2026-10-17')`;
    yield* sql`WITH RECURSIVE history(n) AS (
    SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 151
  ) INSERT INTO orchestration_events
    SELECT n, 2, 'thread', 'thread',
      CASE WHEN n IN (1, 51, 101) THEN 'message.updated' ELSE 'thread.visited' END,
      '{"id":"message"}' FROM history`;
    yield* sql`WITH RECURSIVE history(n) AS (
    SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < ${receiptCount}
  ) INSERT INTO orchestration_command_receipts (
    rowid, command_id, command_type, aggregate_kind, aggregate_id
  ) SELECT n * 2, 'command-' || n, 'legacy', 'thread', 'imported' FROM history`;
  });

it.live("discovers on the reader worker and deletes on the writer", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filename = path.join(yield* fs.makeTempDirectoryScoped(), "fixture.sqlite");
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* seed();
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
      const result = yield* maintenance.compactEventStore;
      assert.equal(result.deletedEventCount, 148);
      assert.equal(result.deletedReceiptCount, 101);
      assert.deepEqual(
        reads.filter((query) => /\bSELECT\b/.test(query)),
        [],
      );
      assert(writes.some((query) => query.includes("DELETE FROM orchestration_events")));
      assert(writes.some((query) => query.includes("DELETE FROM orchestration_command_receipts")));
    }).pipe(
      Effect.provide(
        maintenanceLayer.pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename, readerWorker: true })),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "limits active slices to a page over 25 ms and resumes both cursors and retention state",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const clock = yield* Clock.Clock;
      yield* seed(100);
      const firstPage = yield* Deferred.make<void>();
      const pauseStarted = yield* Deferred.make<void>();
      const secondPage = yield* Deferred.make<void>();
      let activeNanos = 0n;
      let eventPages = 0;
      let receiptPages = 0;
      const pauses: number[] = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (time, exit) => {
            end(time, exit);
            const query = span.attributes.get("db.query.text");
            if (typeof query !== "string" || !query.includes("LIMIT")) return;
            if (query.includes("FROM orchestration_events AS event")) {
              eventPages++;
              Deferred.doneUnsafe(firstPage, Effect.void);
              if (eventPages === 2) Deferred.doneUnsafe(secondPage, Effect.void);
            } else if (query.includes("FROM orchestration_command_receipts AS receipt")) {
              receiptPages++;
            } else return;
            // Model a page exceeding the active budget, without wall-clock sleeps.
            activeNanos += 30_000_000n;
          };
          return span;
        },
      });
      const fiber = yield* maintenance.compactEventStore.pipe(
        Effect.withTracer(tracer),
        Effect.provideService(Clock.Clock, {
          ...clock,
          monotonicTimeNanos: Effect.sync(() => activeNanos),
          sleep: (duration) => {
            pauses.push(Duration.toMillis(duration));
            Deferred.doneUnsafe(pauseStarted, Effect.void);
            return clock.sleep(duration);
          },
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(firstPage);
      yield* Deferred.await(pauseStarted);
      yield* TestClock.adjust("269 millis");
      assert.equal(eventPages, 1);
      assert.deepEqual(pauses, [270]);
      // Foreground work can commit during the pause. It must not extend this scan's bounds.
      yield* sql`INSERT INTO orchestration_events VALUES (
      152, 2, 'thread', 'thread', 'thread.metadata-updated', '{}'
    )`;
      yield* sql`INSERT INTO orchestration_command_receipts VALUES (
      'after-start', 'legacy', 'thread', 'imported'
    )`;
      yield* TestClock.adjust("1 millis");
      yield* Deferred.await(secondPage);
      assert.equal(eventPages, 2);
      yield* TestClock.adjust("10 seconds");
      const result = yield* Fiber.join(fiber);
      assert.equal(eventPages, 4);
      assert.equal(receiptPages, 2);
      assert.deepEqual(pauses, Array(5).fill(270));
      assert.equal(result.deletedEventCount, 148);
      assert.equal(result.deletedReceiptCount, 100);
      assert.deepEqual(yield* sql`SELECT sequence FROM orchestration_events ORDER BY sequence`, [
        { sequence: 1 },
        { sequence: 101 },
        { sequence: 151 },
        { sequence: 152 },
      ]);
      assert.deepEqual(yield* sql`SELECT command_id FROM orchestration_command_receipts`, [
        { command_id: "after-start" },
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        maintenanceLayer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" }))),
      ),
    ),
);
