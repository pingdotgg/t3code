import { ThreadId, TurnItemId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as McpAppModelContext from "./McpAppModelContext.ts";

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const layer = it.layer(
  Layer.merge(database, McpAppModelContext.layer.pipe(Layer.provide(database))),
);

const threadId = ThreadId.make("thread-context");
const forkId = ThreadId.make("thread-context-fork");

const insertAppItem = (itemId: string, runId: string, runStatus: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${runId}, ${threadId}, ${runId.length}, 'codex', ${runStatus}, '2026-01-01', '{}')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
      VALUES (${itemId}, ${threadId}, ${runId}, 0, 'dynamic_tool', 'completed', '2026-01-01', '{}')
    `;
  });

layer("McpAppModelContext", (it) => {
  it.effect("sends only apps still in the thread's history, including a fork's", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const store = yield* McpAppModelContext.McpAppModelContext;
      yield* insertAppItem("item-kept", "run-a", "completed");
      yield* insertAppItem("item-rolled-back", "run-bb", "rolled_back");
      const set = (thread: ThreadId, itemId: string, text: string) =>
        store.set({
          threadId: thread,
          itemId: TurnItemId.make(itemId),
          server: "todos",
          tool: "list_todos",
          text,
        });
      yield* set(threadId, "item-kept", "kept");
      yield* set(threadId, "item-rolled-back", "from a rolled-back run");
      yield* set(threadId, "item-deleted", "from an item that is gone");

      yield* set(forkId, "item-kept", "from the fork");
      yield* set(forkId, "item-rolled-back", "inherited before the rollback");

      const texts = (thread: ThreadId) =>
        store.forThread(thread).pipe(Effect.map((entries) => entries.map((entry) => entry.text)));
      assert.deepEqual(yield* texts(threadId), ["kept"]);
      assert.deepEqual(yield* texts(forkId), ["from the fork", "inherited before the rollback"]);

      yield* set(threadId, "item-kept", "");
      assert.deepEqual(yield* texts(threadId), []);
    }),
  );

  it.effect("drops pre-/clear MCP app notes, but not for a restarted scheduled fresh run", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const store = yield* McpAppModelContext.McpAppModelContext;
      const clearedThread = ThreadId.make("thread-cleared-context");

      yield* sql`
        INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES
          ('run-before-clear', ${clearedThread}, 1, 'codex', 'completed', '2026-01-01', '{"startedAt":"2026-01-01"}'),
          ('run-clear', ${clearedThread}, 2, 'codex', 'completed', '2026-01-02', '{"freshContext":true,"startedAt":"2026-01-02","userMessageId":"msg-clear"}'),
          ('run-after-clear', ${clearedThread}, 3, 'codex', 'completed', '2026-01-03', '{"startedAt":"2026-01-03"}'),
          ('run-scheduled-fresh', ${clearedThread}, 4, 'codex', 'completed', '2026-01-04', '{"freshContext":true,"startedAt":"2026-01-04","userMessageId":"msg-restart"}')
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
        VALUES
          ('item-before-clear', ${clearedThread}, 'run-before-clear', 1, 'dynamic_tool', 'completed', '2026-01-01', '{}'),
          ('item-after-clear', ${clearedThread}, 'run-after-clear', 2, 'dynamic_tool', 'completed', '2026-01-03', '{}'),
          ('item-scheduled-prompt', ${clearedThread}, 'run-scheduled-fresh', 3, 'user_message', 'completed', '2026-01-04', '{"messageId":"msg-scheduled","scheduledTaskId":"sched-1"}'),
          ('item-restart-prompt', ${clearedThread}, 'run-scheduled-fresh', 4, 'user_message', 'completed', '2026-01-04', '{"messageId":"msg-restart"}')
      `;

      yield* store.set({
        threadId: clearedThread,
        itemId: TurnItemId.make("item-before-clear"),
        server: "todos",
        tool: "list_todos",
        text: "stale pre-clear note",
      });
      yield* store.set({
        threadId: clearedThread,
        itemId: TurnItemId.make("item-after-clear"),
        server: "todos",
        tool: "list_todos",
        text: "fresh post-clear note",
      });

      const entries = yield* store.forThread(clearedThread);
      assert.deepEqual(
        entries.map((entry) => entry.text),
        ["fresh post-clear note"],
      );
    }),
  );
});
