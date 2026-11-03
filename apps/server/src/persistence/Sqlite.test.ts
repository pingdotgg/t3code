// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";

import * as SqlitePersistence from "./Sqlite.ts";

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

const insertSearchableMessage = (sql: SqlClient.SqlClient) => sql`
  INSERT INTO orchestration_v2_projection_messages (
    message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
  ) VALUES (
    'message:vacuum', 'thread:vacuum', NULL, NULL, 'user', 0,
    '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z',
    '{"text":"vacuum search text","createdBy":"user"}'
  )
`;
const searchHits = (sql: SqlClient.SqlClient) =>
  sql<{ readonly rowid: number }>`
    SELECT rowid FROM orchestration_v2_message_search
    WHERE orchestration_v2_message_search MATCH '"vacuum search"'
  `;
const messageRowids = (sql: SqlClient.SqlClient) =>
  sql<{ readonly rowid: number }>`SELECT rowid FROM orchestration_v2_projection_messages`;
const pendingRebuild = (sql: SqlClient.SqlClient) => sql`
  SELECT projection_name FROM orchestration_v2_projection_metadata
  WHERE projection_name = 'message-search-rebuild-pending'
`;

it.effect("rebuilds message search on open when a conversion was interrupted", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-search-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const persistence = () =>
    SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertSearchableMessage(sql);
      // VACUUM finished but the process died before the rebuild.
      yield* sql`INSERT INTO orchestration_v2_message_search (orchestration_v2_message_search) VALUES ('delete-all')`;
      yield* sql`
        INSERT INTO orchestration_v2_projection_metadata (
          projection_name, schema_version, last_sequence, updated_at
        ) VALUES ('message-search-rebuild-pending', 0, 0, '1970-01-01T00:00:00.000Z')
      `;
      assert.deepEqual(yield* searchHits(sql), []);
    }).pipe(Effect.provide(persistence()));

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(yield* searchHits(sql), yield* messageRowids(sql));
      assert.deepEqual(yield* pendingRebuild(sql), []);
    }).pipe(Effect.provide(persistence()));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("a failed startup VACUUM leaves search alone and still opens", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-vacuum-fail-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const persistence = () =>
    SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));
  // Low disk fails the VACUUM, and would fail a search rebuild the same way. Transformers are
  // typed infallible, but a failure here surfaces to the caller as that statement's SqlError.
  const sqlFailure = Effect.fail(
    new SqlError.SqlError({ reason: new SqlError.LockTimeoutError({ cause: null }) }),
  ) as unknown as Effect.Effect<Statement.Statement<unknown>>;
  const failVacuum: Statement.Transformer = (statement) =>
    statement.compile()[0].trim() === "VACUUM" || statement.compile()[0].includes("'delete-all'")
      ? sqlFailure
      : Effect.succeed(statement);

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA auto_vacuum = NONE`;
      yield* sql`VACUUM`;
      yield* insertSearchableMessage(sql);
    }).pipe(Effect.provide(persistence()));

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(yield* sql`PRAGMA auto_vacuum`, [{ auto_vacuum: 0 }]);
      assert.deepEqual(yield* pendingRebuild(sql), []);
      assert.deepEqual(yield* searchHits(sql), yield* messageRowids(sql));
    }).pipe(
      Effect.provide(
        persistence().pipe(Layer.provide(Layer.succeed(Statement.CurrentTransformer, failVacuum))),
      ),
    );
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("turns on incremental auto_vacuum for a small existing database when it opens", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-vacuum-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const persistence = () =>
    SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));

  return Effect.gen(function* () {
    // Databases created before incremental auto_vacuum became the default have none.
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA auto_vacuum = NONE`;
      yield* sql`VACUUM`;
      yield* sql`CREATE TABLE retained (value TEXT)`;
      yield* sql`INSERT INTO retained VALUES ('keep')`;
      yield* insertSearchableMessage(sql);
      // A stale index stands in for rowids VACUUM renumbered; only a rebuild refills it.
      yield* sql`INSERT INTO orchestration_v2_message_search (orchestration_v2_message_search) VALUES ('delete-all')`;
      assert.deepEqual(yield* sql`PRAGMA auto_vacuum`, [{ auto_vacuum: 0 }]);
    }).pipe(Effect.provide(persistence()));

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(yield* sql`PRAGMA auto_vacuum`, [{ auto_vacuum: 2 }]);
      assert.deepEqual(yield* sql`SELECT value FROM retained`, [{ value: "keep" }]);
      assert.deepEqual(yield* searchHits(sql), yield* messageRowids(sql));
      assert.deepEqual(yield* pendingRebuild(sql), []);
    }).pipe(Effect.provide(persistence()));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
