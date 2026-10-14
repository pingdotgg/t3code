// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { WAL_SIZE_LIMIT_BYTES } from "./Sqlite.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const lockHolderSource = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN IMMEDIATE");
process.stdout.write("locked\\n");
setTimeout(() => {
  db.exec("COMMIT");
  db.close();
}, Number(process.argv[2]));
`;

const spawnWriteLockHolder = (dbPath: string, holdMs: number) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        const holder = NodeChildProcess.spawn(
          process.execPath,
          ["-e", lockHolderSource, dbPath, String(holdMs)],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        holder.stdout.once("data", () => resolve());
        holder.on("error", reject);
        holder.on("exit", () =>
          reject(new Error("lock holder exited before acquiring the write lock")),
        );
      }),
  );

it.effect("waits out a concurrent writer instead of failing with SQLITE_BUSY", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-busy-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE busy_probe(id INTEGER PRIMARY KEY)`;
    yield* spawnWriteLockHolder(dbPath, 300);
    yield* sql`INSERT INTO busy_probe(id) VALUES (${1})`;
    const rows = yield* sql<{ readonly id: number }>`SELECT id FROM busy_probe`;
    assert.deepEqual([...rows], [{ id: 1 }]);
  }).pipe(
    Effect.provide(SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("limits the WAL file size in the shared persistence setup", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly journal_size_limit: number }>`PRAGMA journal_size_limit`;
    assert.equal(rows[0]?.journal_size_limit, WAL_SIZE_LIMIT_BYTES);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("collects planner statistics for an existing database on open", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-stats-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const persistence = () =>
    SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE stats_probe(id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL)`;
      yield* sql`CREATE INDEX stats_probe_thread_idx ON stats_probe(thread_id)`;
      yield* sql`
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
        INSERT INTO stats_probe(thread_id) SELECT 'thread-' || (i % 10) FROM n
      `;
    }).pipe(Effect.provide(persistence()));

    // A database written before statistics existed gets them on the next open.
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly stat: string }>`
        SELECT stat FROM sqlite_stat1 WHERE idx = 'stats_probe_thread_idx'
      `;
      assert.deepEqual([...rows], [{ stat: "1000 100" }]);
    }).pipe(Effect.provide(persistence()));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("only fsyncs the database file at WAL checkpoints", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-sync-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly synchronous: number }>`PRAGMA synchronous`;
    // 1 is NORMAL.
    assert.equal(rows[0]?.synchronous, 1);
  }).pipe(
    Effect.provide(SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("applies busy_timeout in the shared persistence setup", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly timeout: number }>`PRAGMA busy_timeout`;
    assert.equal(rows[0]?.timeout, 5000);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("enables checkpoint_fullfsync in the shared persistence setup", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly checkpoint_fullfsync: number;
    }>`PRAGMA checkpoint_fullfsync`;
    assert.equal(rows[0]?.checkpoint_fullfsync, 1);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
