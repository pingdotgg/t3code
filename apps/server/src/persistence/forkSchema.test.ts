// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const upsertThread = (threadId: string, payloadJson: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json
      )
      VALUES (
        ${threadId}, 'project-1', 'title', 'codex', 'full-access', 'default',
        '2026-11-27T00:00:00.000Z', '2026-11-27T00:00:00.000Z', ${payloadJson}
      )
      ON CONFLICT(thread_id) DO UPDATE SET payload_json = excluded.payload_json
    `;
  });

const tagged = (tags: ReadonlyArray<string>, extra: object = {}) =>
  JSON.stringify({ ...extra, tags });

const indexedTags = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly thread_id: string; readonly tag: string }>`
    SELECT thread_id, tag FROM orchestration_v2_projection_thread_tags ORDER BY thread_id, tag
  `;
  return rows.map((row) => [row.thread_id, row.tag]);
});

const recountedTags = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly thread_id: string; readonly tag: string }>`
    SELECT DISTINCT t.thread_id, tag.value AS tag
    FROM orchestration_v2_projection_threads t, json_each(t.payload_json, '$.tags') tag
    WHERE json_valid(t.payload_json) AND tag.type = 'text'
    ORDER BY t.thread_id, tag.value
  `;
  return rows.map((row) => [row.thread_id, row.tag]);
});

const assertTags = (expected: ReadonlyArray<readonly [string, string]>) =>
  Effect.gen(function* () {
    const actual = yield* indexedTags;
    assert.deepEqual(actual, yield* recountedTags);
    assert.deepEqual(
      actual,
      expected.map(([threadId, tag]) => [threadId, tag]),
    );
  });

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("fork schema", (it) => {
  it.effect("backfills thread tags and keeps them equal to the thread payloads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 119 });
      yield* upsertThread("thread-1", tagged(["a", "b"]));
      yield* upsertThread("thread-2", "{}");
      yield* upsertThread("thread-3", tagged(["a", "a"]));
      yield* upsertThread("damaged", "not json");
      yield* runMigrations();
      yield* assertTags([
        ["thread-1", "a"],
        ["thread-1", "b"],
        ["thread-3", "a"],
      ]);

      yield* upsertThread("thread-4", tagged(["c"]));
      yield* upsertThread("thread-2", tagged(["a"]));
      yield* upsertThread("thread-1", tagged(["b"], { title: "renamed" }));
      yield* upsertThread("thread-3", tagged(["a"], { title: "same tags" }));
      yield* upsertThread("damaged", "still not json");
      yield* assertTags([
        ["thread-1", "b"],
        ["thread-2", "a"],
        ["thread-3", "a"],
        ["thread-4", "c"],
      ]);

      yield* upsertThread("thread-4", "{}");
      yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = 'thread-1'`;
      yield* assertTags([
        ["thread-2", "a"],
        ["thread-3", "a"],
      ]);

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT thread_id FROM orchestration_v2_projection_thread_tags WHERE tag = 'a'
      `;
      assert.isTrue(
        plan.some((row) => row.detail.includes("orchestration_v2_projection_thread_tags_tag_idx")),
      );
    }),
  );

  it.effect("leaves a current fork schema alone on a second startup", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const schema = () => sql`SELECT type, name, sql FROM sqlite_schema ORDER BY name`;
      yield* runMigrations();
      const before = yield* schema();
      // A rebuild would drop this row, so its survival shows the second run wrote nothing.
      yield* sql`
        INSERT INTO orchestration_v2_projection_thread_tags (thread_id, tag) VALUES ('marker', 'x')
      `;
      assert.deepEqual(yield* runMigrations(), []);
      assert.deepEqual(yield* schema(), before);
      assert.deepEqual(
        yield* sql`SELECT tag FROM orchestration_v2_projection_thread_tags WHERE thread_id = 'marker'`,
        [{ tag: "x" }],
      );
    }),
  );
});

it.effect("matches a recount after a restart, rebuilding when a trigger went missing", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-schema-"));
  const persistence = () =>
    SqlitePersistence.layerFromPath(NodePath.join(tempDir, "state.sqlite")).pipe(
      Layer.provide(NodeServices.layer),
    );
  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      yield* upsertThread("thread-1", tagged(["a"]));
      yield* upsertThread("thread-2", tagged(["a", "b"]));
    }).pipe(Effect.provide(persistence()));

    yield* assertTags([
      ["thread-1", "a"],
      ["thread-2", "a"],
      ["thread-2", "b"],
    ]).pipe(Effect.provide(persistence()));

    // An upstream migration that rebuilds the threads table drops its triggers, so tags drift.
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TRIGGER orchestration_v2_projection_thread_tags_update`;
      yield* upsertThread("thread-1", tagged(["c"]));
    }).pipe(Effect.provide(persistence()));

    yield* Effect.gen(function* () {
      yield* assertTags([
        ["thread-1", "c"],
        ["thread-2", "a"],
        ["thread-2", "b"],
      ]);
      yield* upsertThread("thread-2", "{}");
      yield* assertTags([["thread-1", "c"]]);
    }).pipe(Effect.provide(persistence()));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
