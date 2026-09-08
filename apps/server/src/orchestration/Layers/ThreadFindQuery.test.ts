import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { makeThreadFindQuery } from "./ThreadFindQuery.ts";

const threadId = ThreadId.make("find-thread");
const timestamp = "2026-06-01T00:00:00.000Z";
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM projection_thread_messages`;
  yield* sql`DELETE FROM projection_thread_proposed_plans`;
  yield* sql`DELETE FROM projection_threads`;
  yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, created_at, updated_at)
    VALUES (${threadId}, 'project', 'Find', '{"provider":"codex","model":"gpt-5"}', ${timestamp}, ${timestamp})`;
  const revision = yield* Ref.make(1);
  const search = yield* makeThreadFindQuery(() => Ref.get(revision));
  const message = (id: string, text: string, role = "assistant", target = threadId) =>
    sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
      VALUES (${id}, ${target}, 'turn-1', ${role}, ${text}, 0, ${timestamp}, ${timestamp})`;
  const plan = (id: string, text: string) =>
    sql`INSERT INTO projection_thread_proposed_plans (plan_id, thread_id, turn_id, plan_markdown, created_at, updated_at)
      VALUES (${id}, ${threadId}, 'turn-1', ${text}, ${timestamp}, ${timestamp})`;
  return { sql, revision, search, message, plan };
});

it.layer(SqlitePersistenceMemory)("ThreadFindQuery", (it) => {
  it.effect(
    "matches rendered Markdown, progress, code, user text and plan titles in stable order",
    () =>
      Effect.gen(function* () {
        const { search, message, plan } = yield* setup;
        yield* message("a", "orbit**needle** orbitneedle");
        yield* message("b", "`orbitneedle`", "user");
        yield* message("c", "```ts\norbitneedle\n```");
        yield* message("d", "orbitneedle", "system");
        yield* message("e", "[label](https://orbitneedle.invalid)");
        yield* message("foreign", "orbitneedle", "user", ThreadId.make("other"));
        yield* plan("a-plan", "# orbitneedle\n\nAn orbitneedle plan.");
        const results = yield* Effect.forEach([0, 1, 2, 3, 4, 5], (index) =>
          search({ threadId, query: "ORBITNEEDLE", index }),
        );
        assert.deepStrictEqual(
          results.map((result) => [result.match?.sourceId, result.match?.occurrence]),
          [
            ["a", 0],
            ["a", 1],
            ["b", 0],
            ["c", 0],
            ["a-plan", 0],
            ["a-plan", 1],
          ],
        );
        assert.ok(results.every((result) => result.totalMatches === 6));
        assert.equal(results[4]?.proposedPlans[0]?.id, "a-plan");
        assert.equal(
          (yield* search({ threadId, query: "orbitneedle", index: 999 })).activeIndex,
          5,
        );
      }),
  );

  it.effect("preserves substring, punctuation, block boundaries and Unicode matching", () =>
    Effect.gen(function* () {
      const { search, message } = yield* setup;
      yield* message("a", "100% foo_bar İ X orbit\n\nneedle");
      for (const query of ["%", "_", "İ", "X", "00"]) {
        assert.equal((yield* search({ threadId, query })).totalMatches, 1);
      }
      assert.equal((yield* search({ threadId, query: "orbit needle" })).totalMatches, 0);
      assert.equal((yield* search({ threadId, query: "absent" })).match, null);
    }),
  );

  it.effect("searches 3,000 messages across keyset batches but returns at most six messages", () =>
    Effect.gen(function* () {
      const { sql, search } = yield* setup;
      const rows = Array.from({ length: 3000 }, (_, index) => ({
        message_id: `message-${String(index).padStart(4, "0")}`,
        thread_id: threadId,
        role: "assistant",
        text: index % 999 === 0 ? "orbit**needle**" : "Ordinary conversation",
        is_streaming: 0,
        created_at: timestamp,
        updated_at: timestamp,
      }));
      for (let index = 0; index < rows.length; index += 100) {
        yield* sql`INSERT INTO projection_thread_messages ${sql.insert(rows.slice(index, index + 100))}`;
      }
      for (let index = 0; index < 4; index++) {
        const result = yield* search({ threadId, query: "orbitneedle", index });
        assert.equal(result.totalMatches, 4);
        assert.equal(result.match?.sourceId, rows[index * 999]?.message_id);
        assert.ok(result.messages.length <= 6);
        assert.ok(result.messages.some((message) => message.id === result.match?.sourceId));
      }
    }),
  );

  it.effect(
    "invalidates cached counts after edits/reverts and never searches deleted threads",
    () =>
      Effect.gen(function* () {
        const { sql, revision, search, message } = yield* setup;
        yield* message("a", "needle");
        assert.equal((yield* search({ threadId, query: "needle" })).totalMatches, 1);
        yield* sql`UPDATE projection_thread_messages SET text = 'needle needle' WHERE message_id = 'a'`;
        yield* Ref.update(revision, (value) => value + 1);
        assert.equal((yield* search({ threadId, query: "needle" })).totalMatches, 2);
        yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 'a'`;
        yield* Ref.update(revision, (value) => value + 1);
        assert.equal((yield* search({ threadId, query: "needle" })).totalMatches, 0);
        yield* message("a", "needle");
        yield* Ref.update(revision, (value) => value + 1);
        assert.equal((yield* search({ threadId, query: "needle" })).totalMatches, 1);
        yield* sql`UPDATE projection_threads SET deleted_at = ${timestamp} WHERE thread_id = ${threadId}`;
        assert.equal((yield* search({ threadId, query: "needle" })).totalMatches, 0);
        assert.equal(
          (yield* search({ threadId: ThreadId.make("missing"), query: "needle" })).totalMatches,
          0,
        );
      }),
  );

  it.effect("does not cache an index built across different projection revisions", () =>
    Effect.gen(function* () {
      const { revision, message } = yield* setup;
      yield* message("a", "needle");
      const search = yield* makeThreadFindQuery(() =>
        Ref.updateAndGet(revision, (value) => value + 1),
      );
      const result = yield* Effect.result(search({ threadId, query: "needle" }));
      assert.equal(result._tag, "Failure");
    }),
  );
});
