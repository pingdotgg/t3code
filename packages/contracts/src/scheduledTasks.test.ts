import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ServerConfigStreamEvent } from "./server.ts";
import { ProjectId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ScheduledAgentTask,
  ScheduledTaskCreateInput,
  ScheduledTaskDeleteInput,
  ScheduledTaskRunNowInput,
  ScheduledTaskSnapshot,
  ScheduledTaskUpdateInput,
} from "./scheduledTasks.ts";

const decodeTask = Schema.decodeUnknownEffect(ScheduledAgentTask);
const decodeSnapshot = Schema.decodeUnknownEffect(ScheduledTaskSnapshot);
const decodeCreateInput = Schema.decodeUnknownEffect(ScheduledTaskCreateInput);
const decodeUpdateInput = Schema.decodeUnknownEffect(ScheduledTaskUpdateInput);
const decodeDeleteInput = Schema.decodeUnknownEffect(ScheduledTaskDeleteInput);
const decodeRunNowInput = Schema.decodeUnknownEffect(ScheduledTaskRunNowInput);
const decodeServerConfigStreamEvent = Schema.decodeUnknownEffect(ServerConfigStreamEvent);
const encodeSnapshot = Schema.encodeEffect(ScheduledTaskSnapshot);

const task = {
  id: "task-1",
  title: "Nightly report",
  prompt: "Summarize repo status",
  enabled: true,
  cadence: "daily",
  target: {
    type: "project",
    projectId: "project-1",
    workspace: {
      mode: "worktree",
      baseBranch: "main",
      startFromOrigin: true,
    },
  },
  modelSelection: {
    instanceId: "codex",
    model: "gpt-5.4",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-07-01T12:00:00.000Z",
  updatedAt: "2026-07-01T12:00:00.000Z",
  lastStartedAt: "2026-07-01T12:01:00.000Z",
  lastFinishedAt: "2026-07-01T12:05:00.000Z",
  lastStatus: "succeeded",
  lastError: null,
  lastThreadId: "thread-1",
} as const;

it.effect("decodes scheduled task definitions and snapshots", () =>
  Effect.gen(function* () {
    const parsedTask = yield* decodeTask(task);
    assert.strictEqual(parsedTask.id, "task-1");
    assert.strictEqual(parsedTask.target.type, "project");
    if (parsedTask.target.type === "project") {
      assert.strictEqual(parsedTask.target.workspace.mode, "worktree");
    }

    const snapshot = yield* decodeSnapshot({
      ...task,
      runState: "scheduled",
      nextRunAt: "2026-07-02T12:05:00.000Z",
    });
    assert.strictEqual(snapshot.runState, "scheduled");
    assert.strictEqual(snapshot.nextRunAt, "2026-07-02T12:05:00.000Z");
    assert.deepStrictEqual(yield* encodeSnapshot(snapshot), {
      ...task,
      runState: "scheduled",
      nextRunAt: "2026-07-02T12:05:00.000Z",
    });
  }),
);

it.effect("decodes scheduled task CRUD inputs", () =>
  Effect.gen(function* () {
    const create = yield* decodeCreateInput({
      title: " Hourly sync ",
      prompt: " Check CI ",
      enabled: true,
      cadence: "hourly",
      target: {
        type: "project",
        projectId: " project-1 ",
        workspace: {
          mode: "local",
          worktreePath: null,
        },
      },
      modelSelection: {
        provider: "codex",
        model: " gpt-5.4 ",
      },
      runtimeMode: "auto-accept-edits",
      interactionMode: "plan",
    });
    assert.strictEqual(create.title, "Hourly sync");
    assert.deepStrictEqual(create.target, {
      type: "project",
      projectId: ProjectId.make("project-1"),
      workspace: {
        mode: "local",
        worktreePath: null,
      },
    });
    assert.deepStrictEqual(create.modelSelection, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    });

    const standalone = yield* decodeCreateInput({
      title: "Standalone check",
      prompt: "Summarize recent work",
      enabled: true,
      cadence: "weekly",
      target: {
        type: "standalone",
      },
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
    });
    assert.deepStrictEqual(standalone.target, { type: "standalone" });

    const update = yield* decodeUpdateInput({
      id: "task-1",
      patch: {
        enabled: false,
        cadence: "monthly",
        target: { type: "standalone" },
      },
    });
    assert.strictEqual(update.patch.enabled, false);
    assert.strictEqual(update.patch.cadence, "monthly");
    assert.deepStrictEqual(update.patch.target, { type: "standalone" });

    assert.strictEqual((yield* decodeDeleteInput({ id: "task-1" })).id, "task-1");
    assert.strictEqual((yield* decodeRunNowInput({ id: "task-1" })).id, "task-1");
  }),
);

it.effect("decodes scheduled task config stream events", () =>
  Effect.gen(function* () {
    const event = yield* decodeServerConfigStreamEvent({
      version: 1,
      type: "scheduledTasksUpdated",
      payload: {
        scheduledTasks: [
          {
            ...task,
            runState: "scheduled",
            nextRunAt: "2026-07-02T12:05:00.000Z",
          },
        ],
      },
    });
    assert.strictEqual(event.type, "scheduledTasksUpdated");
    if (event.type === "scheduledTasksUpdated") {
      assert.strictEqual(event.payload.scheduledTasks[0]?.id, "task-1");
    }
  }),
);
