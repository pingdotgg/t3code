import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

// Each case needs its own database: they migrate to different points, and the
// migration ledger only moves forward.
const withDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

const CONTINUATION_TEXT = "Continue the task from the previous user request";

const insertMessage = Effect.fn("insertMessage")(function* (input: {
  readonly messageId: string;
  readonly role: string;
  readonly text: string;
  readonly originJson: string | null;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_thread_messages (
      message_id, thread_id, turn_id, role, text, attachments_json, origin_json,
      is_streaming, created_at, updated_at
    ) VALUES (
      ${input.messageId}, 'thread-1', 'turn-1', ${input.role}, ${input.text}, '[]',
      ${input.originJson}, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
    )
  `;
});

const searchHits = Effect.fn("searchHits")(function* (term: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly message_id: string;
  }>`
    SELECT messages.message_id
    FROM projection_thread_message_fts
    JOIN projection_thread_messages AS messages
      ON messages.rowid = projection_thread_message_fts.rowid
    WHERE projection_thread_message_fts MATCH ${`"${term}"`}
  `;
  return rows.map((row) => row.message_id);
});

const continuationOrigin = JSON.stringify({
  kind: "workspace-handoff",
  role: "continuation",
  branch: "feature/handoff",
  worktreePath: "/tmp/handoff",
});

describe("055_ExcludeHandoffContinuationsFromSearch", () => {
  it.effect("stops indexing handoff continuations inserted after the migration", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 55 });

      yield* insertMessage({
        messageId: "message-user",
        role: "user",
        text: `${CONTINUATION_TEXT} please`,
        originJson: null,
      });
      yield* insertMessage({
        messageId: "message-continuation",
        role: "user",
        text: CONTINUATION_TEXT,
        originJson: continuationOrigin,
      });

      // The user-authored message that happens to contain the same words is
      // still findable; only the boilerplate continuation is excluded.
      assert.deepStrictEqual(yield* searchHits(CONTINUATION_TEXT), ["message-user"]);
    }).pipe(withDatabase),
  );

  it.effect("removes continuations indexed before the migration ran", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* insertMessage({
        messageId: "message-continuation",
        role: "user",
        text: CONTINUATION_TEXT,
        originJson: continuationOrigin,
      });
      assert.deepStrictEqual(yield* searchHits(CONTINUATION_TEXT), ["message-continuation"]);

      yield* runMigrations({ toMigrationInclusive: 55 });

      assert.deepStrictEqual(yield* searchHits(CONTINUATION_TEXT), []);
    }).pipe(withDatabase),
  );

  it.effect("keeps ordinary messages indexed and updatable", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* insertMessage({
        messageId: "message-user",
        role: "user",
        text: "original haystack",
        originJson: null,
      });

      yield* sql`
        UPDATE projection_thread_messages
        SET text = 'updated haystack'
        WHERE message_id = 'message-user'
      `;

      assert.deepStrictEqual(yield* searchHits("original haystack"), []);
      assert.deepStrictEqual(yield* searchHits("updated haystack"), ["message-user"]);
    }).pipe(withDatabase),
  );
});
