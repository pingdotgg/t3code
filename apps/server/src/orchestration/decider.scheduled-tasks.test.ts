import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  TaskId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationTask,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

// The decider's clock is the Effect test clock, pinned to the epoch, so all
// "now" values inside decisions are 1970-01-01T00:00:00.000Z.
const NOW = "2026-01-01T00:00:00.000Z";
const FUTURE = "1970-01-02T09:00:00.000Z";
const PAST = "1969-12-31T09:00:00.000Z";
const HOUR_MS = 60 * 60 * 1000;

function makeThread(
  input: {
    readonly threadId?: ThreadId;
    readonly deletedAt?: string | null;
  } = {},
) {
  return {
    id: input.threadId ?? ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    deletedAt: input.deletedAt ?? null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

function makeReadModel(input: {
  readonly threads?: ReturnType<typeof makeThread>[];
  readonly tasks?: OrchestrationTask[];
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    threads: input.threads ?? [makeThread()],
    tasks: input.tasks ?? [],
    updatedAt: NOW,
  };
}

function makeTask(input: {
  readonly schedule?: OrchestrationTask["schedule"];
  readonly nextFireAt?: string | null;
  readonly cancelledAt?: string | null;
  readonly updatedAt?: string;
}): OrchestrationTask {
  return {
    taskId: TaskId.make("task-1"),
    projectId: ProjectId.make("project-1"),
    threadId: ThreadId.make("thread-1"),
    prompt: "Run the nightly checks",
    schedule: input.schedule ?? { kind: "interval", everyMs: HOUR_MS },
    createdAt: NOW,
    updatedAt: input.updatedAt ?? NOW,
    lastFiredAt: null,
    // Explicit null must survive: an optional chain would read it as absent.
    nextFireAt: input.nextFireAt === undefined ? FUTURE : input.nextFireAt,
    cancelledAt: input.cancelledAt ?? null,
  };
}

const run = (command: OrchestrationCommand, readModel: OrchestrationReadModel) =>
  decideOrchestrationCommand({ command, readModel });

it.layer(NodeServices.layer)("scheduled task decider", (it) => {
  it.effect("schedules a one-shot task with its absolute fire time", () =>
    Effect.gen(function* () {
      const decided = yield* run(
        {
          type: "task.schedule",
          commandId: CommandId.make("cmd-schedule-once"),
          taskId: TaskId.make("task-once"),
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-1"),
          prompt: "Check the build",
          schedule: { kind: "once", at: FUTURE },
          createdAt: NOW,
        },
        makeReadModel({}),
      );
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("task.scheduled");
      if (events[0]?.type === "task.scheduled") {
        expect(events[0].aggregateKind).toBe("task");
        expect(events[0].payload.nextFireAt).toBe(FUTURE);
      }
    }),
  );

  it.effect("anchors an interval task's first fire one period out", () =>
    Effect.gen(function* () {
      const decided = yield* run(
        {
          type: "task.schedule",
          commandId: CommandId.make("cmd-schedule-interval"),
          taskId: TaskId.make("task-interval"),
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-1"),
          prompt: "Ping the deploy",
          schedule: { kind: "interval", everyMs: HOUR_MS },
          createdAt: NOW,
        },
        makeReadModel({}),
      );
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events[0]?.type).toBe("task.scheduled");
      if (events[0]?.type === "task.scheduled") {
        expect(events[0].payload.nextFireAt).toBe("1970-01-01T01:00:00.000Z");
      }
    }),
  );

  it.effect("rejects a one-shot time in the past", () =>
    Effect.gen(function* () {
      const error = yield* run(
        {
          type: "task.schedule",
          commandId: CommandId.make("cmd-schedule-past"),
          taskId: TaskId.make("task-past"),
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-1"),
          prompt: "Too late",
          schedule: { kind: "once", at: PAST },
          createdAt: NOW,
        },
        makeReadModel({}),
      ).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects a duplicate task id", () =>
    Effect.gen(function* () {
      const error = yield* run(
        {
          type: "task.schedule",
          commandId: CommandId.make("cmd-schedule-dup"),
          taskId: TaskId.make("task-1"),
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-1"),
          prompt: "Duplicate",
          schedule: { kind: "once", at: FUTURE },
          createdAt: NOW,
        },
        makeReadModel({ tasks: [makeTask({})] }),
      ).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects scheduling onto a deleted thread", () =>
    Effect.gen(function* () {
      const error = yield* run(
        {
          type: "task.schedule",
          commandId: CommandId.make("cmd-schedule-deleted"),
          taskId: TaskId.make("task-deleted"),
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-gone"),
          prompt: "Nobody home",
          schedule: { kind: "once", at: FUTURE },
          createdAt: NOW,
        },
        makeReadModel({
          threads: [makeThread({ threadId: ThreadId.make("thread-gone"), deletedAt: NOW })],
        }),
      ).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("fires a due interval task and advances to the next slot", () =>
    Effect.gen(function* () {
      const decided = yield* run(
        {
          type: "task.fire",
          commandId: CommandId.make("cmd-fire"),
          taskId: TaskId.make("task-1"),
          // Fired half a period after the scheduled slot.
          dueAt: "1970-01-01T00:31:00.000Z",
        },
        makeReadModel({ tasks: [makeTask({ nextFireAt: "1970-01-01T00:00:30.000Z" })] }),
      );
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events[0]?.type).toBe("task.fired");
      if (events[0]?.type === "task.fired") {
        expect(events[0].payload.threadId).toBe(ThreadId.make("thread-1"));
        expect(events[0].payload.runtimeMode).toBe("full-access");
        // Anchored to the previous slot + one period, not to the tick time.
        expect(events[0].payload.nextFireAt).toBe("1970-01-01T01:00:30.000Z");
      }
    }),
  );

  it.effect("coalesces downtime into one fire landing on the first future slot", () =>
    Effect.gen(function* () {
      // Hourly task, next slot 90 minutes overdue.
      const decided = yield* run(
        {
          type: "task.fire",
          commandId: CommandId.make("cmd-fire-coalesce"),
          taskId: TaskId.make("task-1"),
          dueAt: "1970-01-01T02:30:00.000Z",
        },
        makeReadModel({ tasks: [makeTask({ nextFireAt: "1970-01-01T01:00:00.000Z" })] }),
      );
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events[0]?.type).toBe("task.fired");
      if (events[0]?.type === "task.fired") {
        expect(events[0].payload.nextFireAt).toBe("1970-01-01T03:00:00.000Z");
      }
    }),
  );

  it.effect("spends a one-shot task's only fire", () =>
    Effect.gen(function* () {
      const decided = yield* run(
        {
          type: "task.fire",
          commandId: CommandId.make("cmd-fire-once"),
          taskId: TaskId.make("task-1"),
          dueAt: FUTURE,
        },
        makeReadModel({ tasks: [makeTask({ schedule: { kind: "once", at: FUTURE } })] }),
      );
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events[0]?.type).toBe("task.fired");
      if (events[0]?.type === "task.fired") {
        expect(events[0].payload.nextFireAt).toBeNull();
      }
    }),
  );

  it.effect("rejects firing ahead of the scheduled time", () =>
    Effect.gen(function* () {
      const error = yield* run(
        {
          type: "task.fire",
          commandId: CommandId.make("cmd-fire-early"),
          taskId: TaskId.make("task-1"),
          dueAt: "1969-12-31T23:59:00.000Z",
        },
        makeReadModel({ tasks: [makeTask({ nextFireAt: FUTURE })] }),
      ).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects firing a cancelled or spent task", () =>
    Effect.gen(function* () {
      for (const task of [
        makeTask({ cancelledAt: NOW }),
        makeTask({ schedule: { kind: "once", at: FUTURE }, nextFireAt: null }),
      ]) {
        const error = yield* run(
          {
            type: "task.fire",
            commandId: CommandId.make("cmd-fire-invalid"),
            taskId: TaskId.make("task-1"),
            dueAt: FUTURE,
          },
          makeReadModel({ tasks: [task] }),
        ).pipe(Effect.flip);
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
      }
    }),
  );

  it.effect("cancels a task and is idempotent on re-cancel", () =>
    Effect.gen(function* () {
      const firstDecided = yield* run(
        {
          type: "task.cancel",
          commandId: CommandId.make("cmd-cancel-1"),
          taskId: TaskId.make("task-1"),
        },
        makeReadModel({ tasks: [makeTask({})] }),
      );
      const first = Array.isArray(firstDecided) ? firstDecided : [firstDecided];
      expect(first[0]?.type).toBe("task.cancelled");
      if (first[0]?.type === "task.cancelled") {
        expect(first[0].payload.cancelledAt).toBe(first[0].payload.updatedAt);

        const secondDecided = yield* run(
          {
            type: "task.cancel",
            commandId: CommandId.make("cmd-cancel-2"),
            taskId: TaskId.make("task-1"),
          },
          makeReadModel({
            tasks: [
              makeTask({
                cancelledAt: "1969-12-31T00:00:00.000Z",
                updatedAt: "1969-12-31T00:00:00.000Z",
                nextFireAt: null,
              }),
            ],
          }),
        );
        const second = Array.isArray(secondDecided) ? secondDecided : [secondDecided];
        if (second[0]?.type === "task.cancelled") {
          expect(second[0].payload.cancelledAt).toBe("1969-12-31T00:00:00.000Z");
          expect(second[0].payload.updatedAt).toBe("1969-12-31T00:00:00.000Z");
        } else {
          throw new Error("expected task.cancelled");
        }
      }
    }),
  );
});
