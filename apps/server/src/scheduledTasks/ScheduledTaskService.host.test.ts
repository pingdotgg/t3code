import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ProjectId, ScheduledTaskUpsertInput, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ScheduledTaskTestkit from "./ScheduledTaskService.testkit.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

// The Mac hosts both projects and the thread; the Windows client hosts none of them.
const macProject = ProjectId.make("project-mac");
const macThread = ThreadId.make("thread-mac");
const otherProject = ProjectId.make("project-mac-other");

/** One environment's scheduler and its own database, hosting the given project and thread. */
const environmentLayer = (
  hosted: { readonly projectId: ProjectId; readonly threadId: ThreadId } | null,
  onSend: (input: ThreadManagementService.ThreadManagementSendInput) => Effect.Effect<void> = () =>
    Effect.void,
) =>
  ScheduledTaskService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ManagedPolicy.layerTest(),
        NodeCrypto.layer,
        Scheduler.layer,
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        ScheduledTaskTestkit.layerLocalProjects(
          (id) => hosted !== null && (id === hosted.projectId || id === otherProject),
        ),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === hosted?.threadId
                ? ({
                    id: threadId,
                    projectId: hosted.projectId,
                    archivedAt: null,
                    deletedAt: null,
                  } as never)
                : null,
            ),
          sendToThread: (input) => onSend(input).pipe(Effect.as({} as never)),
        }),
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

const nightlyInput = (overrides: Record<string, unknown> = {}) =>
  decodeUpsertInput({
    title: "Overnight review",
    prompt: "Review what the agents did today.",
    enabled: true,
    schedule: { type: "cron", expression: "0 4 * * *", timezone: "Asia/Bangkok" },
    projectId: macProject,
    threadId: macThread,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "agent",
    creationSource: "mcp",
    ...overrides,
  });

it.effect("refuses a project or thread another environment hosts", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const service = yield* ScheduledTaskService.ScheduledTaskService;

    const foreignProject = yield* service
      .upsert(yield* nightlyInput({ projectId: "project-elsewhere", threadId: null }))
      .pipe(Effect.flip);
    assert.include(foreignProject.message, "Project project-elsewhere is not on this environment");

    const foreignThread = yield* service
      .upsert(yield* nightlyInput({ threadId: "thread-elsewhere" }))
      .pipe(Effect.flip);
    assert.equal(foreignThread.message, "That thread no longer exists.");
    assert.deepEqual((yield* service.list()).tasks, []);

    // Its own project and thread keep their binding, time zone and idempotent replay.
    const own = yield* nightlyInput({ commandId: "schedule-overnight" });
    const { task } = yield* service.upsert(own);
    assert.equal(task.threadId, macThread);
    assert.deepEqual(task.schedule, {
      type: "cron",
      expression: "0 4 * * *",
      timezone: "Asia/Bangkok",
    });
    assert.equal((yield* service.upsert(own)).task.id, task.id);
    assert.equal((yield* service.list()).tasks.length, 1);

    // Moving the task to another local project leaves the old project's thread for a new one.
    const rebound = yield* service.upsert(
      yield* nightlyInput({ id: task.id, requireExisting: true, projectId: otherProject }),
    );
    assert.equal(rebound.task.projectId, otherProject);
    assert.isNull(rebound.task.threadId);

    // A task stored before this check stays editable where it is; nothing migrates it.
    yield* sql`UPDATE scheduled_tasks SET project_id = 'project-elsewhere', thread_id = NULL`;
    const paused = yield* service.upsert(
      yield* nightlyInput({
        id: task.id,
        requireExisting: true,
        projectId: "project-elsewhere",
        threadId: null,
        enabled: false,
      }),
    );
    assert.isFalse(paused.task.enabled);
  }).pipe(Effect.provide(environmentLayer({ projectId: macProject, threadId: macThread }))),
);

it.effect("a schedule for the Mac's thread runs on the Mac after the Windows client is gone", () =>
  Effect.gen(function* () {
    // 03:59:58 in Bangkok, two seconds before the nightly run.
    yield* TestClock.setTime(Date.parse("2026-10-09T20:59:58.000Z"));

    // The Windows client cannot keep the schedule: it fails instead of storing it there.
    yield* Effect.gen(function* () {
      const windows = yield* ScheduledTaskService.ScheduledTaskService;
      const refused = yield* windows.upsert(yield* nightlyInput()).pipe(Effect.flip);
      assert.include(refused.message, "is not on this environment");
      assert.deepEqual((yield* windows.list()).tasks, []);
    }).pipe(Effect.provide(environmentLayer(null)), Effect.scoped);

    // The Windows runtime is closed. The Mac owns the task and fires it on its own.
    const sent = yield* Deferred.make<ThreadManagementService.ThreadManagementSendInput>();
    yield* Effect.gen(function* () {
      const mac = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* mac.upsert(yield* nightlyInput());
      assert.equal(task.nextRunAt, "2026-10-09T21:00:00.000Z");

      yield* TestClock.adjust("10 seconds");
      const run = yield* Deferred.await(sent);
      assert.equal(run.threadId, macThread);
      assert.equal(run.projectId, macProject);
      assert.equal(run.text, "Review what the agents did today.");
    }).pipe(
      Effect.provide(
        environmentLayer({ projectId: macProject, threadId: macThread }, (input) =>
          Deferred.succeed(sent, input).pipe(Effect.asVoid),
        ),
      ),
      Effect.scoped,
    );
  }),
);
