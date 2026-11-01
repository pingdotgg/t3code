import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ScheduledTaskUpsertInput,
  ThreadId,
  type McpGatewayProfile,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import * as ScheduledTaskTestkit from "./ScheduledTaskService.testkit.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

const profile: McpGatewayProfile = {
  profileId: "reviewer",
  name: "Reviewer",
  revision: 3,
  modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" },
  runtimeMode: "auto-accept-edits",
  interactionMode: "default",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const settingsLayer = Layer.mock(ServerSettingsService)({
  getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, mcpGatewayProfiles: [profile] }),
});

const memoryDatabase = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect(
  "profile tasks launch with the current revision once, then post into their thread; an early manual run keeps a one-time slot",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const launches: Array<ThreadLaunchService.ThreadLaunchInput> = [];
      const sends: Array<ThreadManagementService.ThreadManagementSendInput> = [];
      const dependencies = Layer.mergeAll(
        ScheduledTaskTestkit.layerLocalProjects(),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        NodeCrypto.layer,
        Scheduler.layer,
        settingsLayer,
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            Effect.sync(() => {
              launches.push(input);
              return { threadId: ThreadId.make("thread-reviewer"), resumed: false } as never;
            }),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () => Effect.succeed({ archivedAt: null } as never),
          sendToThread: (input) =>
            Effect.sync(() => {
              sends.push(input);
              return {} as never;
            }),
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const input = yield* decodeUpsertInput({
          title: "Nightly review",
          prompt: "Review today's pull requests.",
          enabled: true,
          schedule: { type: "once", runAt: "2099-01-01T00:00:00.000Z" },
          projectId: "project-review",
          profileId: "reviewer",
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: "codex", model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        });
        const { task } = yield* service.upsert(input);

        const first = yield* service.runNow({ id: task.id });
        assert.equal(launches.length, 1);
        assert.deepEqual(launches[0]?.profileSelection, {
          profileId: "reviewer",
          revision: 3,
          overrideFields: [],
        });
        assert.equal(first.task.threadId, "thread-reviewer");
        assert.isTrue(first.task.enabled);
        assert.equal(first.task.nextRunAt, "2099-01-01T00:00:00.000Z");

        // A client that does not know about profiles re-arms the task without the field.
        const { profileId: _profileId, ...withoutProfile } = input;
        const rearmed = yield* service.upsert({
          ...withoutProfile,
          id: task.id,
          threadId: first.task.threadId,
        });
        assert.equal(rearmed.task.profileId, "reviewer");
        assert.equal(rearmed.task.nextRunAt, "2099-01-01T00:00:00.000Z");

        yield* service.runNow({ id: task.id });
        assert.equal(launches.length, 1);
        assert.equal(sends[0]?.threadId, "thread-reviewer");
        assert.isUndefined(sends[0]?.modelSelection);

        const invalid = yield* service
          .upsert({ ...input, schedule: { type: "cron", expression: "0 7 * *", timezone: "UTC" } })
          .pipe(Effect.flip);
        assert.include(invalid.message, "must have five fields");
      }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(dependencies))));
    }).pipe(Effect.provide(memoryDatabase)),
);

it.effect("imports fork V1 scheduled tasks into the V2 table and drops the legacy table", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toForkMigrationInclusive: 3 });
    yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
      task_id: "fork-task",
      title: "Morning pull",
      prompt: "git pull",
      profile_id: "reviewer",
      project_id: "project-review",
      thread_id: "thread-v1",
      schedule_json: '{"kind":"cron","expression":"0 7 * * 1-5","timezone":"Asia/Bangkok"}',
      enabled: 1,
      next_run_at: "2026-09-26T00:00:00.000Z",
      last_run_at: "2026-09-25T00:00:00.000Z",
      last_run_status: "sent",
      last_run_error: null,
      run_count: 4,
      created_at: "2026-09-20T00:00:00.000Z",
      updated_at: "2026-09-25T00:00:00.000Z",
    })}`;
    yield* runMigrations();

    const dependencies = Layer.mergeAll(
      ScheduledTaskTestkit.layerLocalProjects(),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      NodeCrypto.layer,
      Scheduler.layer,
      settingsLayer,
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
    );
    const { tasks } = yield* Effect.gen(function* () {
      return yield* (yield* ScheduledTaskService.ScheduledTaskService).list();
    }).pipe(Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(dependencies))));

    assert.equal(tasks.length, 1);
    const [task] = tasks;
    assert.deepEqual(task?.schedule, {
      type: "cron",
      expression: "0 7 * * 1-5",
      timezone: "Asia/Bangkok",
    });
    assert.equal(task?.profileId, "reviewer");
    assert.equal(task?.threadId, "thread-v1");
    assert.equal(task?.lastRunStatus, "succeeded");
    assert.equal(task?.runCount, 4);
    assert.equal(task?.nextRunAt, "2026-09-26T00:00:00.000Z");
    assert.deepEqual(task?.modelSelection, profile.modelSelection);
    assert.equal(task?.runtimeMode, "auto-accept-edits");
    const legacy = yield* sql`SELECT name FROM sqlite_master WHERE name = 'legacy_scheduled_tasks'`;
    assert.deepEqual(legacy, []);
  }).pipe(Effect.provide(memoryDatabase)),
);
