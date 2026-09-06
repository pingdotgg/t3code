import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

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

it.effect("polls enabled due tasks through the service while skipping a malformed due row", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-09-05T00:05:00.000Z"));
    const launches = yield* Queue.unbounded<string>();
    yield* Layer.build(
      ScheduledTaskService.layer.pipe(
        Layer.provide([
          NodeCrypto.layer,
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(ThreadLaunch.ThreadLaunchService)({
            launch: (input) =>
              Queue.offer(launches, input.title).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ThreadLaunch.ThreadLaunchError({
                      operation: "create-thread",
                      commandId: input.commandId,
                      projectId: input.projectId,
                      cause: new Error("Fixture stops at the dispatch boundary"),
                    }),
                  ),
                ),
              ),
          }),
        ]),
      ),
    );

    // Insert after startup recovery so the running row represents an active run.
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

    yield* TestClock.adjust("5 seconds");
    assert.strictEqual(yield* Queue.take(launches), "scheduled-task:due");
    assert.strictEqual(yield* Queue.size(launches), 0);
  }).pipe(Effect.scoped, Effect.provide(SqlitePersistenceMemory)),
);
