import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { loadDueScheduledTasks } from "./ScheduledTaskService.ts";

const intervalScheduleJson = '{"type":"interval","everyMs":60000}';
const rootWorkspaceStrategyJson = '{"type":"root"}';
const codexModelSelectionJson = '{"instanceId":"codex","model":"gpt-5.4"}';

const insertTask = Effect.fn("ScheduledTaskServiceTest.insertTask")(function* (input: {
  readonly id: string;
  readonly enabled: boolean;
  readonly nextRunAt: string;
  readonly lastRunStatus?: "never" | "running";
  readonly scheduleJson?: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO scheduled_tasks (
      task_id,
      title,
      prompt,
      enabled,
      schedule_json,
      project_id,
      thread_id,
      workspace_strategy_json,
      model_selection_json,
      runtime_mode,
      interaction_mode,
      created_by,
      creation_source,
      created_at,
      updated_at,
      next_run_at,
      last_run_at,
      last_run_status,
      last_run_error,
      run_count
    ) VALUES (
      ${input.id},
      ${input.id},
      'Run the task',
      ${input.enabled ? 1 : 0},
      ${input.scheduleJson ?? intervalScheduleJson},
      'project:scheduled-due',
      NULL,
      ${rootWorkspaceStrategyJson},
      ${codexModelSelectionJson},
      'full-access',
      'default',
      'user',
      'server',
      '2026-09-05T00:00:00.000Z',
      '2026-09-05T00:00:00.000Z',
      ${input.nextRunAt},
      NULL,
      ${input.lastRunStatus ?? "never"},
      NULL,
      0
    )
  `;
});

it.effect("loads only enabled due tasks while skipping a malformed due row", () =>
  Effect.gen(function* () {
    yield* insertTask({
      id: "scheduled-task:due",
      enabled: true,
      nextRunAt: "2026-09-05T00:00:00.000Z",
    });
    yield* insertTask({
      id: "scheduled-task:disabled",
      enabled: false,
      nextRunAt: "2026-09-05T00:00:00.000Z",
    });
    yield* insertTask({
      id: "scheduled-task:future",
      enabled: true,
      nextRunAt: "2026-09-05T00:10:00.000Z",
    });
    yield* insertTask({
      id: "scheduled-task:running",
      enabled: true,
      nextRunAt: "2026-09-05T00:00:00.000Z",
      lastRunStatus: "running",
    });
    // Due, but intentionally invalid for the contract decoder.
    yield* insertTask({
      id: "scheduled-task:malformed-due",
      enabled: true,
      nextRunAt: "2026-09-05T00:00:00.000Z",
      scheduleJson: "{malformed",
    });

    const tasks = yield* loadDueScheduledTasks("2026-09-05T00:05:00.000Z");

    assert.deepEqual(
      tasks.map((task) => task.id),
      ["scheduled-task:due"],
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
