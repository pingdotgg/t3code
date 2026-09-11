import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { listDueTasks } from "./ScheduledTaskService.ts";

it.effect("loads only due tasks and skips a corrupt due row without decoding settled tasks", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-09-09T12:00:00.000Z";
    for (const row of [
      { id: "due-now", next: now, enabled: 1, status: "never", corrupt: false },
      {
        id: "due-earlier",
        next: "2026-09-09T11:00:00.000Z",
        enabled: 1,
        status: "failed",
        corrupt: false,
      },
      { id: "due-corrupt", next: now, enabled: 1, status: "never", corrupt: true },
      { id: "disabled", next: now, enabled: 0, status: "never", corrupt: true },
      {
        id: "future",
        next: "2026-09-09T12:00:00.001Z",
        enabled: 1,
        status: "never",
        corrupt: true,
      },
      { id: "unscheduled", next: null, enabled: 1, status: "never", corrupt: true },
      { id: "running", next: now, enabled: 1, status: "running", corrupt: true },
    ]) {
      yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
        task_id: row.id,
        title: row.id,
        prompt: "Run task",
        enabled: row.enabled,
        schedule_json: row.corrupt ? "broken" : '{"type":"interval","everyMs":60000}',
        project_id: "project:test",
        thread_id: null,
        workspace_strategy_json: '{"type":"root"}',
        model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
        runtime_mode: "full-access",
        interaction_mode: "default",
        created_by: "user",
        creation_source: "web",
        created_at: now,
        updated_at: now,
        next_run_at: row.next,
        last_run_at: null,
        last_run_status: row.status,
        last_run_error: null,
        run_count: 0,
      })}`;
    }
    const warnings: unknown[] = [];
    const tasks = yield* listDueTasks(DateTime.makeUnsafe(now)).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make(({ message }) => {
            warnings.push(message);
          }),
        ]),
      ),
    );
    assert.deepEqual(
      tasks.map((task) => task.id),
      ["due-earlier", "due-now"],
    );
    assert.equal(warnings.length, 1);
    const running = yield* sql<{
      last_run_status: string;
    }>`SELECT last_run_status FROM scheduled_tasks WHERE task_id = 'running'`;
    assert.equal(running[0]?.last_run_status, "running");
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
