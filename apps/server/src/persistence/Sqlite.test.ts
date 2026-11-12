// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import type * as NodeWorkerThreads from "node:worker_threads";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerOwnership from "../serverOwnership.ts";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const workers = vi.hoisted((): Array<NodeWorkerThreads.Worker> => []);
const workerData = vi.hoisted((): Array<unknown> => []);

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeWorkerThreads>();
  class RecordedWorker extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) {
      super(...args);
      workers.push(this);
      workerData.push(args[1]?.workerData);
    }
  }
  return { ...actual, Worker: RecordedWorker };
});

it.effect("keeps writes moving past a 48 MiB WAL while a reader retains its snapshot", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-burst-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const persistence = SqlitePersistence.layerFromPath(dbPath).pipe(
    Layer.provide(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const checkpointWorker = workers.at(-1)!;
    yield* sql`CREATE TABLE burst_probe(id INTEGER PRIMARY KEY, payload BLOB)`;
    yield* sql`INSERT INTO burst_probe VALUES (1, NULL)`;
    yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
    const reader = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeSqlite.DatabaseSync(dbPath, { readOnly: true })),
      (database) => Effect.sync(() => database.close()),
    );
    reader.exec("BEGIN");
    assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM burst_probe").get()?.count, 1);

    yield* sql.withTransaction(
      sql`INSERT INTO burst_probe VALUES (2, zeroblob(${48 * 1024 * 1024}))`,
    );
    const state = yield* Effect.callback<{
      readonly log: number;
      readonly checkpointed: number;
      readonly blocked: boolean;
    }>((resume) => {
      const onMessage = (message: {
        readonly type?: string;
        readonly log?: number;
        readonly checkpointed?: number;
        readonly blocked?: boolean;
      }) => {
        if (
          message.type === "checkpoint" &&
          typeof message.log === "number" &&
          message.log > 10_000 &&
          typeof message.checkpointed === "number" &&
          typeof message.blocked === "boolean"
        ) {
          checkpointWorker.off("message", onMessage);
          resume(
            Effect.succeed({
              log: message.log,
              checkpointed: message.checkpointed,
              blocked: message.blocked,
            }),
          );
        }
      };
      checkpointWorker.on("message", onMessage);
      checkpointWorker.ref();
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
      checkpointWorker.postMessage("barrier");
      return Effect.sync(() => checkpointWorker.off("message", onMessage));
    });
    assert.isBelow(state.checkpointed, state.log);
    assert.isFalse(state.blocked);

    yield* sql.withTransaction(sql`INSERT INTO burst_probe VALUES (3, NULL)`);
    assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM burst_probe").get()?.count, 1);
    reader.exec("COMMIT");
    assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM burst_probe").get()?.count, 3);
  }).pipe(
    Effect.scoped,
    Effect.provide(persistence),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

// Linux names an open, already-deleted file "<path> (deleted)" in /proc/self/fd.
// SQLite names its temp files "etilqs_*" and, without TMPDIR, puts them in
// /var/tmp while os.tmpdir() is /tmp, so match the name, not the directory.
const openDeletedTempFiles = () =>
  NodeFS.readdirSync("/proc/self/fd").flatMap((fd) => {
    try {
      const target = NodeFS.readlinkSync(`/proc/self/fd/${fd}`);
      return target.includes("/etilqs_") && target.endsWith(" (deleted)") ? [target] : [];
    } catch {
      return [];
    }
  });

it.effect.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "keeps a write transaction's statement journal off the temp directory",
  () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-temp-"));
    const persistence = SqlitePersistence.layerFromPath(
      NodePath.join(tempDir, "state.sqlite"),
    ).pipe(Layer.provide(NodeServices.layer));

    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE journal_probe(id INTEGER PRIMARY KEY, payload TEXT NOT NULL)`;
      for (let id = 0; id < 64; id++) {
        yield* sql`INSERT INTO journal_probe VALUES (${id}, ${"x".repeat(4096)})`;
      }
      const before = new Set(openDeletedTempFiles());
      const opened = yield* sql.withTransaction(
        Effect.gen(function* () {
          // A multi-row update can fail halfway, so SQLite journals every page
          // it changes, here well past the 64 KiB it holds in memory by default.
          yield* sql`UPDATE journal_probe SET payload = payload || 'y'`;
          return openDeletedTempFiles().filter((target) => !before.has(target));
        }),
      );
      assert.deepEqual(opened, []);
    }).pipe(
      Effect.provide(persistence),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  },
);

it.effect("drops planner statistics a database already has", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-stats-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const persistence = () =>
    SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE walk_probe(node_id TEXT PRIMARY KEY, parent_node_id TEXT)`;
      yield* sql`INSERT INTO walk_probe VALUES ('node-1', NULL), ('node-2', 'node-1')`;
      yield* sql`ANALYZE walk_probe`;
    }).pipe(Effect.provide(persistence()));

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const stats = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM sqlite_stat1
      `;
      assert.equal(stats[0]?.count, 0);
      // A connection still using the old stats scans the table at each step.
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        WITH RECURSIVE retained(node_id) AS (
          SELECT 'node-2'
          UNION
          SELECT parent.parent_node_id FROM walk_probe AS parent
          INNER JOIN retained ON parent.node_id = retained.node_id
        )
        SELECT node_id FROM retained
      `;
      assert.include(
        plan.map((row) => row.detail),
        "SEARCH parent USING INDEX sqlite_autoindex_walk_probe_1 (node_id=?)",
      );
    }).pipe(Effect.provide(persistence()));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("upgrades an existing database on a read-write worker connection", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-upgrade-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL;`;
      yield* runMigrations({ toMigrationInclusive: 81 });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
    const startedBefore = workerData.length;

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        rows.map((row) => [row.migration_id, row.name] as const),
        migrationManifest,
      );
    }).pipe(
      Effect.provide(
        SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer)),
      ),
    );
    assert.deepInclude(workerData.slice(startedBefore), {
      filename: dbPath,
      readOnly: false,
      allowExtension: false,
      prepareCacheSize: 200,
    });
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("names a database file that is not SQLite", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-notadb-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  NodeFS.writeFileSync(dbPath, "not a db\n");

  return Effect.gen(function* () {
    const opened = yield* Effect.void.pipe(
      Effect.provide(
        SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer)),
      ),
      Effect.result,
    );

    assert.equal(opened._tag, "Failure");
    if (opened._tag === "Failure") {
      assert.isTrue(SqlError.isSqlError(opened.failure));
      assert.include(opened.failure.message, dbPath);
    }
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

const ownT3Home = Effect.fn(function* () {
  const { serverRuntimeStatePath } = yield* ServerConfig.ServerConfig;
  // An empty home, so no boot service installed on this machine is read.
  const home = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
  yield* ServerOwnership.acquireServerOwnership(serverRuntimeStatePath).pipe(
    Effect.provide(ProcessRunner.layer),
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provideService(HostProcess.Environment, {}),
  );
});

const migrateTo = (toMigrationInclusive?: number) =>
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    yield* runMigrations({ toMigrationInclusive }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: dbPath })),
    );
  });

const latestRecordedMigrationId = Effect.gen(function* () {
  const { dbPath } = yield* ServerConfig.ServerConfig;
  const rows = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly id: number }>`
      SELECT MAX(migration_id) AS id FROM effect_sql_migrations
    `;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
  return rows[0]?.id;
});

const layerT3Home = ServerConfig.layerTest(process.cwd(), { prefix: "t3-sqlite-cli-" });

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("layerCliConfig", (it) => {
  it.effect("does not migrate a T3 home a running server owns", () =>
    Effect.gen(function* () {
      const recorded = Math.max(...migrationManifest.map(([id]) => id)) - 1;
      yield* migrateTo(recorded);
      yield* ownT3Home();

      const opened = yield* Effect.void.pipe(
        Effect.provide(SqlitePersistence.layerCliConfig),
        Effect.result,
      );

      assert.equal(yield* latestRecordedMigrationId, recorded);
      assert.equal(opened._tag, "Failure");
      if (opened._tag === "Failure") {
        assert.instanceOf(opened.failure, SqlitePersistence.ServerOwnsDatabaseError);
      }
    }).pipe(Effect.scoped, Effect.provide(layerT3Home)),
  );

  it.effect("opens a current T3 home while a running server owns it", () =>
    Effect.gen(function* () {
      yield* migrateTo();
      yield* ownT3Home();

      yield* Effect.void.pipe(Effect.provide(SqlitePersistence.layerCliConfig));
    }).pipe(Effect.scoped, Effect.provide(layerT3Home)),
  );
});
