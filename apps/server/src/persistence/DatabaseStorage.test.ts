import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as DatabaseStorage from "./DatabaseStorage.ts";
import * as Sqlite from "./Sqlite.ts";

const freePages = Effect.map(
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`,
  ),
  (rows) => rows[0]?.freelist_count ?? 0,
);

const storageLayer = <E>(
  config: Layer.Layer<ServerConfig.ServerConfig, E, FileSystem.FileSystem | Path.Path>,
) =>
  DatabaseStorage.layer.pipe(
    Layer.provide(ProjectionMaintenance.layer),
    Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(config),
    Layer.provide(NodeServices.layer),
  );

const testConfig = ServerConfig.layerTest(process.cwd(), { prefix: "database-storage-" });

const currentStatus = Effect.flatMap(DatabaseStorage.DatabaseStorage, (storage) =>
  storage.status.pipe(Stream.take(1), Stream.runHead),
);

it.effect("a new database returns freed pages online without losing data", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const storage = yield* DatabaseStorage.DatabaseStorage;
    assert.deepEqual(yield* sql`PRAGMA auto_vacuum`, [{ auto_vacuum: 2 }]);
    yield* sql`CREATE TABLE retained (value TEXT)`;
    yield* sql`INSERT INTO retained VALUES ('keep')`;
    yield* sql`CREATE TABLE discarded (value BLOB)`;
    yield* sql`INSERT INTO discarded VALUES (zeroblob(1048576))`;
    yield* sql`DROP TABLE discarded`;
    assert.isAbove(yield* freePages, 0);
    yield* storage.reclaim;
    assert.equal(yield* freePages, 0);
    assert.deepEqual(yield* sql`SELECT value FROM retained`, [{ value: "keep" }]);
  }).pipe(Effect.provide(storageLayer(testConfig))),
);

it.effect("publishes file accounting and the doctor command after each pass", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const config = yield* ServerConfig.ServerConfig;
    yield* sql`CREATE TABLE discarded (value BLOB)`;
    yield* sql`INSERT INTO discarded VALUES (zeroblob(1048576))`;
    yield* TestClock.adjust("1 minute");
    const before = (yield* currentStatus).pipe(Option.getOrThrow);
    assert.isNotNull(before);
    assert.isAbove(before!.databaseBytes, 1048576);
    assert.isTrue(before!.incrementalVacuumEnabled);
    // Quoting follows the host shell, so check each word on its own.
    assert.include(before!.compactCommand, "doctor");
    assert.include(before!.compactCommand, "--base-dir");
    assert.include(before!.compactCommand, config.baseDir);

    // The next reclaim pass frees the dropped table and republishes.
    yield* sql`DROP TABLE discarded`;
    yield* TestClock.adjust("1 minute");
    const storage = yield* DatabaseStorage.DatabaseStorage;
    const after = yield* storage.status.pipe(
      Stream.filter((status) => status !== null && status.databaseBytes < before!.databaseBytes),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
    assert.isAtMost(after!.databaseBytes, before!.databaseBytes - 1048576);
    assert.equal(after!.reclaimableBytes, 0);
  }).pipe(Effect.provide(storageLayer(testConfig))),
);

it.effect("publishes nothing when doctor would repair a different database", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust("1 minute");
    assert.deepEqual(yield* currentStatus, Option.some(null));
  }).pipe(
    Effect.provide(
      storageLayer(
        // A dev server without an explicit home keeps state in <baseDir>/dev,
        // while `doctor --base-dir` targets <baseDir>/userdata.
        Layer.effect(
          ServerConfig.ServerConfig,
          Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            return { ...config, dbPath: `${config.baseDir}/dev/statev2.sqlite` };
          }),
        ).pipe(Layer.provide(testConfig)),
      ),
    ),
  ),
);

const compactionLayer = (
  compactEventStore: ProjectionMaintenance.ProjectionMaintenanceV2["Service"]["compactEventStore"],
) =>
  DatabaseStorage.layer.pipe(
    Layer.provide(
      Layer.succeed(ProjectionMaintenance.ProjectionMaintenanceV2, {
        compactEventStore,
        verify: Effect.die("unexpected verification"),
        rebuild: Effect.die("unexpected rebuild"),
      }),
    ),
    Layer.provide(Sqlite.layerMemory),
  );

const minute = 60_000;
const hour = 60 * minute;
const startupTime = Date.UTC(2026, 9, 19);
const emptyCompaction = { deletedEventCount: 0, deletedReceiptCount: 0, reclaimableBytes: 0 };

it.effect.each([
  { name: "recent success", saved: String(startupTime - 2 * hour), delay: 4 * hour },
  { name: "overdue success", saved: String(startupTime - 7 * hour), delay: minute },
  { name: "nearly due success", saved: String(startupTime - 6 * hour + 1), delay: minute },
  { name: "future timestamp", saved: String(startupTime + hour), delay: 6 * hour },
  { name: "missing timestamp", saved: undefined, delay: minute },
  { name: "invalid timestamp", saved: "not a timestamp", delay: minute },
  { name: "unreadable timestamp", saved: undefined, delay: minute },
])("schedules startup compaction after $name", ({ name, saved, delay }) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startupTime);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const timestampPath = path.join(path.dirname(config.dbPath), "compacted-at");
    if (name === "unreadable timestamp") yield* fs.makeDirectory(timestampPath);
    else if (saved !== undefined) yield* fs.writeFileString(timestampPath, saved);
    const started = yield* Deferred.make<number>();
    const compact = Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) => Deferred.succeed(started, now)),
      Effect.as(emptyCompaction),
    );
    yield* Effect.gen(function* () {
      yield* TestClock.adjust(delay - 1);
      assert.isFalse(yield* Deferred.isDone(started));
      yield* TestClock.adjust(1);
      assert.equal(yield* Deferred.await(started), startupTime + delay);
    }).pipe(Effect.provide(compactionLayer(compact)));
  }).pipe(Effect.provide(testConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it.effect.each(["success", "compaction failure", "timestamp write failure"] as const)(
  "keeps the six-hour cadence after %s and remembers only successful completion",
  (outcome) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(startupTime);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const timestampPath = path.join(path.dirname(config.dbPath), "compacted-at");
      const previous = String(startupTime - 7 * hour);
      if (outcome === "timestamp write failure") yield* fs.makeDirectory(timestampPath);
      else yield* fs.writeFileString(timestampPath, previous);
      const starts = yield* Queue.unbounded<number>();
      const finish = yield* Queue.unbounded<void>();
      const writeFinished = yield* Deferred.make<void>();
      const compact = Effect.gen(function* () {
        yield* Queue.offer(starts, yield* Clock.currentTimeMillis);
        yield* Queue.take(finish);
        if (outcome === "compaction failure") {
          return yield* new ProjectionMaintenance.ProjectionMaintenanceError({ operation: "test" });
        }
        return emptyCompaction;
      });
      yield* Effect.gen(function* () {
        yield* TestClock.adjust(minute);
        assert.equal(yield* Queue.take(starts), startupTime + minute);
        yield* TestClock.adjust(2 * minute);
        if (outcome !== "timestamp write failure") {
          assert.equal(yield* fs.readFileString(timestampPath), previous);
        }
        yield* Queue.offer(finish, undefined);
        if (outcome !== "compaction failure") yield* Deferred.await(writeFinished);
        yield* TestClock.adjust(6 * hour - 1);
        assert.equal(yield* Queue.size(starts), 0);
        yield* TestClock.adjust(1);
        assert.equal(yield* Queue.take(starts), startupTime + 3 * minute + 6 * hour);
      }).pipe(
        Effect.provide(compactionLayer(compact)),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFileString: (file, content, options) =>
            fs
              .writeFileString(file, content, options)
              .pipe(Effect.ensuring(Deferred.succeed(writeFinished, undefined))),
        }),
      );
      if (outcome !== "timestamp write failure") {
        const saved = Number(yield* fs.readFileString(timestampPath));
        assert.equal(saved, outcome === "success" ? startupTime + 3 * minute : Number(previous));
      }
    }).pipe(Effect.provide(testConfig.pipe(Layer.provideMerge(NodeServices.layer)))),
);
