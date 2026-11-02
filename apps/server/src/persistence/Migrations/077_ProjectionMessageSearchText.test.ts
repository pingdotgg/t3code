import { assert, it } from "@effect/vitest";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { recreateMessageSearchTriggers } from "../../orchestration-v2/messageSearchIndex.ts";
import { runMigrations } from "../Migrations.ts";

const createdAt = "2026-10-01T00:00:00.000Z";
const quote = serializeAssistantCitation({
  version: 1,
  environmentId: EnvironmentId.make("environment:local"),
  threadId: ThreadId.make("thread:quoted"),
  messageId: MessageId.make("quoted-answer"),
  text: "A lighthouse guides ships safely through the darkness.",
  comment: "what are you talking about",
  start: 0,
  end: 54,
  prefix: "beacon01",
  suffix: "harbor",
});
const readable =
  "A lighthouse guides ships safely through the darkness.\nComment: what are you talking about";
const indexed = (sql: SqlClient.SqlClient, phrase: string) =>
  sql<{ readonly message_id: string }>`
    SELECT messages.message_id
    FROM orchestration_v2_message_search AS search
    INNER JOIN orchestration_v2_projection_messages AS messages
      ON messages.rowid = search.rowid
    WHERE orchestration_v2_message_search MATCH ${phrase}
  `.pipe(Effect.map((rows) => rows.map((row) => row.message_id)));

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "077_ProjectionMessageSearchText",
  (it) => {
    it.effect("backfills readable text only for messages whose citations read differently", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 76 });
        const insertMessage = (messageId: string, text: unknown) => sql`
          INSERT INTO orchestration_v2_projection_messages (
            message_id, thread_id, role, streaming, created_at, updated_at, payload_json
          ) VALUES (
            ${messageId}, 'thread:quote', 'user', 0, ${createdAt}, ${createdAt},
            ${JSON.stringify({ text })}
          )
        `;
        yield* insertMessage("quoted", `${quote} quiet silver lantern`);
        yield* insertMessage("plain", "quiet silver lantern");
        yield* insertMessage("invalid", "[Assistant quote](t3-citation://v1/not-a-citation)");
        yield* insertMessage("unreadable", 20261001);
        yield* insertMessage(
          "accented",
          serializeAssistantCitation({
            version: 1,
            environmentId: EnvironmentId.make("environment:local"),
            threadId: ThreadId.make("thread:quoted"),
            messageId: MessageId.make("quoted-answer"),
            text: "The kittiwake's résumé",
            start: 0,
            end: 22,
            prefix: "",
            suffix: "",
          }),
        );
        yield* Effect.forEach(
          Array.from({ length: 501 }, (_, index) => `page-${String(index).padStart(3, "0")}`),
          (messageId) => insertMessage(messageId, quote),
          { discard: true },
        );

        assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 77 }), [
          [77, "ProjectionMessageSearchText"],
        ]);
        const rows = yield* sql<{
          readonly message_id: string;
          readonly search_text: string | null;
        }>`SELECT message_id, search_text FROM orchestration_v2_projection_messages`;
        const searchText = new Map(rows.map((row) => [row.message_id, row.search_text]));
        assert.equal(searchText.get("quoted"), `${readable} quiet silver lantern`);
        assert.isNull(searchText.get("plain"));
        assert.isNull(searchText.get("invalid"));
        assert.isNull(searchText.get("unreadable"));
        assert.equal(searchText.get("page-000"), readable);
        assert.equal(searchText.get("page-500"), readable);

        // Messages indexed as stored are indexed again as they read.
        assert.deepEqual(yield* indexed(sql, '"résumé"'), ["accented"]);
        assert.deepEqual(yield* indexed(sql, `"kittiwake's"`), ["accented"]);
        assert.deepEqual(yield* indexed(sql, '"beacon01"'), []);
        assert.lengthOf(yield* indexed(sql, '"what are you talking about"'), 502);
      }),
    );

    it.effect("keeps indexing readable text when a later migration recreates the triggers", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* recreateMessageSearchTriggers(sql);

        yield* sql`
          INSERT INTO orchestration_v2_projection_messages (
            message_id, thread_id, role, streaming, created_at, updated_at, payload_json,
            search_text
          ) VALUES (
            'recreated', 'thread:quote', 'user', 0, ${createdAt}, ${createdAt},
            ${JSON.stringify({ text: `${quote} lantern recreated` })},
            ${`${readable} lantern recreated`}
          )
        `;
        assert.deepEqual(yield* indexed(sql, '"talking about lantern recreated"'), ["recreated"]);
      }),
    );
  },
);
