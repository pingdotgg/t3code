import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("081_TurnItemInlineWorkOutput", (it) => {
  it.effect("flags existing dynamic tools whose output renders inline", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 80 });
      const rows: ReadonlyArray<readonly [string, string, object, number]> = [
        ["delegate", "dynamic_tool", { toolName: "mcp__t3_code__delegate_task" }, 1],
        ["html", "dynamic_tool", { toolName: "x", output: { htmlRender: {} } }, 1],
        ["mcp-app", "dynamic_tool", { toolName: "x", output: { t3McpApp: {} } }, 1],
        ["image", "dynamic_tool", { toolName: "view_image", viewedImagePath: "/a.png" }, 1],
        ["plain", "dynamic_tool", { toolName: "mcp__docs__search", output: "ok" }, 0],
        ["command", "command_execution", { output: "htmlRender" }, 0],
      ];
      for (const [id, type, payload] of rows) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, 'thread-1', 0, ${type}, 'completed', '2026-11-01T00:00:00.000Z',
            ${JSON.stringify({ type, ...payload })}
          )
        `;
      }

      yield* runMigrations({ toMigrationInclusive: 81 });
      const flagged = yield* sql<{ readonly turn_item_id: string; readonly inline: number }>`
        SELECT turn_item_id, inline_work_output AS inline
        FROM orchestration_v2_projection_turn_items
      `;
      assert.deepStrictEqual(
        new Map(flagged.map((row) => [row.turn_item_id, row.inline])),
        new Map(rows.map(([id, , , inline]) => [id, inline])),
      );
    }),
  );
});
