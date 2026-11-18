import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { listThreadMentionLinks } from "../../orchestration-v2/threadMentionLinks.ts";
import { runMigrations } from "../Migrations.ts";

const NOW = "2026-11-10T00:00:00.000Z";

const chip = (threadId: string, environmentId = "env-1") => ({
  kind: "thread",
  threadId,
  environmentId,
  contextId: `ctx-${threadId}-${environmentId}`,
  label: "t",
  version: 1,
  title: "t",
});

const links = (threadId: string) =>
  listThreadMentionLinks({
    threadId: ThreadId.make(threadId),
    environmentId: EnvironmentId.make("env-1"),
  }).pipe(Effect.map((result) => result.links));

const insertMessage = (
  id: string,
  threadId: string,
  runId: string | null,
  records: ReadonlyArray<unknown>,
  streaming = 0,
  role: "user" | "assistant" = "user",
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages (
        message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
      )
      VALUES (
        ${id}, ${threadId}, ${runId}, NULL, ${role}, ${streaming}, ${NOW}, ${NOW},
        ${JSON.stringify({ text: "x", context: { version: 1, records } })}
      )
    `;
  });

const seedThreads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at
    )
    VALUES ('p1', 'P1', '/p1', '[]', ${NOW}, ${NOW})
  `;
  const threads = [
    ["a", null, {}],
    ["b", null, {}],
    ["c", null, {}],
    ["side", null, { lineage: { sideChat: true } }],
    ["arch", NOW, {}],
  ] as const;
  for (const [threadId, archivedAt, payload] of threads) {
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, archived_at, payload_json
      )
      VALUES (
        ${threadId}, 'p1', ${threadId}, 'codex', 'full-access', 'default',
        ${NOW}, ${NOW}, ${archivedAt}, ${JSON.stringify(payload)}
      )
    `;
  }
  for (const [runId, ordinal] of [
    ["run-a1", 1],
    ["run-a2", 2],
  ] as const) {
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, status, requested_at, payload_json
      )
      VALUES (${runId}, 'a', ${ordinal}, 'codex', 'completed', ${NOW}, '{}')
    `;
  }
});

const backfillFixture = Effect.gen(function* () {
  yield* runMigrations({ toMigrationInclusive: 110 });
  yield* seedThreads;
  yield* insertMessage("m1", "a", "run-a1", [
    chip("b"),
    chip("a"),
    chip("c", "env-2"),
    chip("arch"),
    { kind: "file", path: "x" },
    "stray",
  ]);
  yield* insertMessage("m2", "a", "run-a2", [chip("b")]);
  yield* insertMessage("m3", "side", null, [chip("b")]);
  yield* runMigrations();
});

const freshDatabase = Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }));

it.effect("backfills thread chips and applies the read filters", () =>
  Effect.gen(function* () {
    yield* backfillFixture;
    assert.deepStrictEqual(yield* links("a"), [
      { threadId: ThreadId.make("arch"), direction: "mentions" },
      { threadId: ThreadId.make("b"), direction: "mentions" },
    ]);
    assert.deepStrictEqual(yield* links("b"), [
      { threadId: ThreadId.make("a"), direction: "mentionedBy" },
    ]);
    assert.deepStrictEqual(yield* links("c"), []);
  }).pipe(freshDatabase),
);

it.effect("backfills safely when a message payload is malformed", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 110 });
    yield* seedThreads;
    // 100's partial index rejects non-JSON user payloads; assistant rows can still hold one.
    yield* insertMessage("malformed", "a", null, [chip("b")], 1, "assistant");
    yield* sql`
      UPDATE orchestration_v2_projection_messages SET payload_json = 'not json {'
      WHERE message_id = 'malformed'
    `;
    yield* runMigrations();
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM orchestration_v2_thread_mentions WHERE message_id = 'malformed'`,
      [],
    );
  }).pipe(freshDatabase),
);

it.effect("follows inserts, context edits and deletes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* seedThreads;
    const mentionedByC = Effect.map(links("b"), (rows) =>
      rows.some((row) => row.threadId === "c" && row.direction === "mentionedBy"),
    );

    yield* insertMessage("m4", "c", null, [chip("b")]);
    assert.isTrue(yield* mentionedByC);

    yield* sql`
      UPDATE orchestration_v2_projection_messages
      SET payload_json = json_remove(payload_json, '$.context')
      WHERE message_id = 'm4'
    `;
    assert.isFalse(yield* mentionedByC);

    yield* sql`
      UPDATE orchestration_v2_projection_messages
      SET payload_json = ${JSON.stringify({ text: "x", context: { version: 1, records: [chip("b")] } })}
      WHERE message_id = 'm4'
    `;
    assert.isTrue(yield* mentionedByC);

    yield* sql`UPDATE orchestration_v2_projection_messages SET thread_id = 'a' WHERE message_id = 'm4'`;
    assert.deepStrictEqual(yield* links("b"), [
      { threadId: ThreadId.make("a"), direction: "mentionedBy" },
    ]);

    yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE message_id = 'm4'`;
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM orchestration_v2_thread_mentions WHERE message_id = 'm4'`,
      [],
    );
  }).pipe(freshDatabase),
);

it.effect("deduplicates thread chips on message upsert inserts and updates", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* seedThreads;
    for (const target of ["b", "a"]) {
      const payload = JSON.stringify({
        text: "x",
        context: {
          version: 1,
          records: [chip(target), { ...chip(target), contextId: "another-context" }],
        },
      });
      yield* sql`
        INSERT INTO orchestration_v2_projection_messages (
          message_id, thread_id, run_id, node_id, role, streaming,
          created_at, updated_at, payload_json, search_text
        )
        VALUES ('upsert', 'c', NULL, NULL, 'user', 0, ${NOW}, ${NOW}, ${payload}, 'x')
        ON CONFLICT(message_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          run_id = excluded.run_id,
          node_id = excluded.node_id,
          role = excluded.role,
          streaming = excluded.streaming,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          payload_json = excluded.payload_json,
          search_text = excluded.search_text
      `;
      const rows = yield* sql<{ readonly target: string }>`
        SELECT target_thread_id AS target FROM orchestration_v2_thread_mentions
        WHERE message_id = 'upsert'
      `;
      assert.deepStrictEqual(rows, [{ target }]);
    }
  }).pipe(freshDatabase),
);

it.effect("keeps rows when only the text changes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* seedThreads;
    yield* insertMessage("m5", "c", null, [chip("b")]);
    yield* sql`
      CREATE TEMP TRIGGER forbid_mention_rewrites
      AFTER DELETE ON orchestration_v2_thread_mentions
      BEGIN
        SELECT RAISE(ABORT, 'mention rows were rewritten');
      END
    `;
    yield* sql`
      UPDATE orchestration_v2_projection_messages
      SET payload_json = json_set(payload_json, '$.text', 'edited'), streaming = 1
      WHERE message_id = 'm5'
    `;
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_v2_thread_mentions WHERE message_id = 'm5'
    `;
    assert.strictEqual(rows[0]?.count, 1);

    yield* sql`
      INSERT INTO orchestration_v2_projection_messages (
        message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
      )
      VALUES (
        'm6', 'c', NULL, NULL, 'assistant', 1, ${NOW}, ${NOW},
        ${JSON.stringify({ text: "", context: { version: 1, records: [chip("b")] } })}
      )
    `;
    for (const text of ["one", "one two", "one two three"]) {
      yield* sql`
        UPDATE orchestration_v2_projection_messages
        SET payload_json = json_set(payload_json, '$.text', ${text})
        WHERE message_id = 'm6'
      `;
    }
    yield* sql`DROP TRIGGER forbid_mention_rewrites`;
    yield* sql`
      UPDATE orchestration_v2_projection_messages
      SET payload_json = ${JSON.stringify({ text: "done", context: { version: 1, records: [chip("a")] } })},
        streaming = 0
      WHERE message_id = 'm6'
    `;
    const targets = yield* sql<{ readonly target: string }>`
      SELECT target_thread_id AS target FROM orchestration_v2_thread_mentions WHERE message_id = 'm6'
    `;
    assert.deepStrictEqual(targets, [{ target: "a" }]);
  }).pipe(freshDatabase),
);

it.effect("does no JSON work while a message streams", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* seedThreads;
    yield* insertMessage("m7", "c", null, [chip("b")], 1, "assistant");
    yield* sql`
      UPDATE orchestration_v2_projection_messages
      SET payload_json = 'not json {', streaming = 1
      WHERE message_id = 'm7'
    `;
    const rows = yield* sql<{ readonly payload: string }>`
      SELECT payload_json AS payload FROM orchestration_v2_projection_messages
      WHERE message_id = 'm7'
    `;
    assert.deepStrictEqual(rows, [{ payload: "not json {" }]);
  }).pipe(freshDatabase),
);

it.effect("re-indexes a context changed mid-stream when the message finishes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* seedThreads;
    const payloadToA = JSON.stringify({
      text: "x",
      context: { version: 1, records: [chip("a")] },
    });
    for (const id of ["m8", "m9"]) {
      yield* insertMessage(id, "c", null, [chip("b")], 1);
      yield* sql`
        UPDATE orchestration_v2_projection_messages
        SET payload_json = ${payloadToA}, streaming = 1
        WHERE message_id = ${id}
      `;
    }
    yield* sql`
      UPDATE orchestration_v2_projection_messages
      SET payload_json = ${payloadToA}, streaming = 0
      WHERE message_id = 'm8'
    `;
    yield* sql`UPDATE orchestration_v2_projection_messages SET streaming = 0 WHERE message_id = 'm9'`;
    const targets = yield* sql<{ readonly id: string; readonly target: string }>`
      SELECT message_id AS id, target_thread_id AS target FROM orchestration_v2_thread_mentions
      WHERE message_id IN ('m8', 'm9') ORDER BY message_id
    `;
    assert.deepStrictEqual(targets, [
      { id: "m8", target: "a" },
      { id: "m9", target: "a" },
    ]);
  }).pipe(freshDatabase),
);

it.effect(
  "drops rolled-back, never-started cancelled, deleted, side-chat and project-deleted threads",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* backfillFixture;

      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'rolled_back'`;
      assert.deepStrictEqual(yield* links("b"), []);
      yield* sql`
      UPDATE orchestration_v2_projection_runs
      SET status = 'cancelled', payload_json = json_set(payload_json, '$.startedAt', NULL)
    `;
      assert.deepStrictEqual(yield* links("b"), []);
      assert.deepStrictEqual(yield* links("a"), []);
      yield* sql`
      UPDATE orchestration_v2_projection_runs
      SET payload_json = json_set(payload_json, '$.startedAt', ${NOW})
      WHERE run_id = 'run-a1'
    `;
      assert.deepStrictEqual(yield* links("b"), [
        { threadId: ThreadId.make("a"), direction: "mentionedBy" },
      ]);
      assert.deepStrictEqual(yield* links("a"), [
        { threadId: ThreadId.make("arch"), direction: "mentions" },
        { threadId: ThreadId.make("b"), direction: "mentions" },
      ]);
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed'`;

      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = ${NOW} WHERE thread_id = 'a'`;
      assert.deepStrictEqual(yield* links("b"), []);
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = NULL WHERE thread_id = 'a'`;

      const onlyArch = [{ threadId: ThreadId.make("arch"), direction: "mentions" as const }];
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = ${NOW} WHERE thread_id = 'b'`;
      assert.deepStrictEqual(yield* links("a"), onlyArch);
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = NULL WHERE thread_id = 'b'`;

      yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET payload_json = json_set(payload_json, '$.lineage', json('{"sideChat":true}'))
      WHERE thread_id = 'b'
    `;
      assert.deepStrictEqual(yield* links("a"), onlyArch);
      yield* sql`
      UPDATE orchestration_v2_projection_threads
      SET payload_json = json_remove(payload_json, '$.lineage')
      WHERE thread_id = 'b'
    `;
      assert.strictEqual((yield* links("a")).length, 2);

      yield* sql`UPDATE projection_projects SET deleted_at = ${NOW} WHERE project_id = 'p1'`;
      assert.deepStrictEqual(yield* links("b"), []);
    }).pipe(freshDatabase),
);

it.effect("lists both directions when two threads mention each other", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    yield* seedThreads;
    yield* insertMessage("ab", "a", null, [chip("b")]);
    yield* insertMessage("ba", "b", null, [chip("a")]);
    assert.deepStrictEqual(yield* links("a"), [
      { threadId: ThreadId.make("b"), direction: "mentionedBy" },
      { threadId: ThreadId.make("b"), direction: "mentions" },
    ]);
  }).pipe(freshDatabase),
);
