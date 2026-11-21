import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("100_TurnItemOrbitTaskInline", (it) => {
  it.effect("flags existing Orbit task-create dynamic tools as inline work output", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 99 });
      const rows: ReadonlyArray<readonly [string, string, object, number]> = [
        ["mcp-task", "dynamic_tool", { toolName: "mcp__orbit__task-create", output: "{}" }, 1],
        ["dot-task", "dynamic_tool", { toolName: "orbit.task_create", output: "{}" }, 1],
        ["compact-task", "dynamic_tool", { toolName: "tool", output: { orbitTask: { id: 1 } } }, 1],
        ["plain", "dynamic_tool", { toolName: "mcp__orbit__task-list", output: "ok" }, 0],
        ["command", "command_execution", { output: '"orbitTask"' }, 0],
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

      yield* runMigrations({ toMigrationInclusive: 100 });
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
