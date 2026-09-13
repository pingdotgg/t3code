import {
  CommandId,
  ProjectId,
  TaskId,
  ThreadId,
  TurnId,
  CheckpointRef,
  ProviderInstanceId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";
import { resolveTaskAutoSettlementAt } from "./ThreadSettlementPolicy.ts";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project");
const foreignProjectId = ProjectId.make("foreign-project");
const taskId = TaskId.make("task");
const threadId = ThreadId.make("thread");
const commandId = CommandId.make("command");
const taskCreate = {
  type: "task.create",
  commandId,
  taskId,
  primaryProjectId: projectId,
  name: "  My task  ",
  createdAt: now,
} as const;
const threadCreate = {
  type: "thread.create",
  commandId,
  threadId,
  projectId: foreignProjectId,
  title: "Member",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feature",
  worktreePath: "/foreign/worktree",
  createdAt: now,
} as const;

const apply = Effect.fn(function* (
  model: ReturnType<typeof createEmptyReadModel>,
  command: OrchestrationCommand,
) {
  const decided = yield* decideOrchestrationCommand({ readModel: model, command });
  const events = Array.isArray(decided) ? decided : [decided];
  for (const event of events) {
    model = yield* projectEvent(model, {
      ...event,
      sequence: model.snapshotSequence + 1,
    } as OrchestrationEvent);
  }
  return { model, events };
});
const seed = Effect.gen(function* () {
  let model = createEmptyReadModel(now);
  for (const id of [projectId, foreignProjectId]) {
    ({ model } = yield* apply(model, {
      type: "project.create",
      commandId,
      projectId: id,
      title: id,
      workspaceRoot: `/${id}`,
      createdAt: now,
    }));
  }
  ({ model } = yield* apply(model, taskCreate));
  ({ model } = yield* apply(model, threadCreate));
  return model;
});

it.layer(NodeServices.layer)("task decisions", (it) => {
  it.effect(
    "creates empty tasks and clears sparse metadata without changing the primary project",
    () =>
      Effect.gen(function* () {
        let model = yield* seed;
        expect(model.tasks[0]).toMatchObject({
          name: "My task",
          description: null,
          primaryProjectId: projectId,
          archivedAt: null,
        });
        expect(model.threads[0]?.taskId).toBe(null);
        ({ model } = yield* apply(model, {
          type: "task.meta.update",
          commandId,
          taskId,
          description: "Details",
        }));
        ({ model } = yield* apply(model, {
          type: "task.meta.update",
          commandId,
          taskId,
          name: "Renamed",
        }));
        expect(model.tasks[0]?.description).toBe("Details");
        ({ model } = yield* apply(model, {
          type: "task.meta.update",
          commandId,
          taskId,
          description: null,
        }));
        expect(model.tasks[0]).toMatchObject({
          name: "Renamed",
          description: null,
          primaryProjectId: projectId,
        });
      }),
  );
  it.effect(
    "moves cross-project members, removes pins, and preserves checkout and lifecycle on removal",
    () =>
      Effect.gen(function* () {
        let model = yield* seed;
        ({ model } = yield* apply(model, { type: "thread.pin", commandId, threadId }));
        const before = model.threads[0]!;
        const moved = yield* apply(model, { type: "thread.task.set", commandId, threadId, taskId });
        model = moved.model;
        expect(moved.events.map((event) => event.type)).toEqual([
          "thread.unpinned",
          "thread.task-set",
        ]);
        expect(model.threads[0]).toMatchObject({
          taskId,
          pinnedAt: null,
          projectId: before.projectId,
          branch: before.branch,
          worktreePath: before.worktreePath,
          session: before.session,
        });
        const duplicate = yield* apply(model, {
          type: "thread.task.set",
          commandId: CommandId.make("retry"),
          threadId,
          taskId,
        });
        expect(duplicate.events).toHaveLength(1);
        expect(duplicate.model.threads[0]).toEqual(model.threads[0]);
        ({ model } = yield* apply(model, { type: "thread.archive", commandId, threadId }));
        const archivedAt = model.threads[0]?.archivedAt;
        ({ model } = yield* apply(model, {
          type: "thread.task.set",
          commandId,
          threadId,
          taskId: null,
        }));
        expect(model.threads[0]).toMatchObject({
          taskId: null,
          archivedAt,
          branch: "feature",
          worktreePath: "/foreign/worktree",
        });
      }),
  );
  it.effect(
    "identifies missing and archived membership destinations without tagging other task commands",
    () =>
      Effect.gen(function* () {
        const initial = yield* seed;
        for (const reason of ["missing", "archived"] as const) {
          const model =
            reason === "missing"
              ? { ...initial, tasks: [] }
              : { ...initial, tasks: initial.tasks.map((task) => ({ ...task, archivedAt: now })) };
          for (const command of [
            { ...threadCreate, threadId: ThreadId.make("new-member"), taskId },
            { type: "thread.task.set", commandId, threadId, taskId },
          ] satisfies OrchestrationCommand[]) {
            const error = yield* decideOrchestrationCommand({ readModel: model, command }).pipe(
              Effect.flip,
            );
            expect(error).toMatchObject({
              _tag: "OrchestrationCommandInvariantError",
              taskMembershipRejection: reason,
            });
          }
          const error = yield* decideOrchestrationCommand({
            readModel: model,
            command: { type: "task.pin", commandId, taskId },
          }).pipe(Effect.flip);
          expect(error).not.toHaveProperty("taskMembershipRejection");
        }
      }),
  );

  it.effect("validates task destinations, primary projects, unique IDs and nonempty names", () =>
    Effect.gen(function* () {
      const model = yield* seed;
      const invalid: OrchestrationCommand[] = [
        taskCreate,
        { ...taskCreate, taskId: TaskId.make("empty"), name: " " },
        {
          ...taskCreate,
          taskId: TaskId.make("missing-project"),
          primaryProjectId: ProjectId.make("missing"),
        },
        { type: "thread.task.set", commandId, threadId, taskId: TaskId.make("missing") },
        { ...threadCreate, threadId: ThreadId.make("task:reserved") },
      ];
      for (const command of invalid) {
        expect(
          yield* decideOrchestrationCommand({ readModel: model, command }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
      }
      const archived = {
        ...model,
        tasks: model.tasks.map((task) => ({ ...task, archivedAt: now })),
      };
      expect(
        yield* decideOrchestrationCommand({
          readModel: archived,
          command: { type: "thread.task.set", commandId, threadId, taskId },
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
      const deletedProject = {
        ...model,
        projects: model.projects.map((project) => ({ ...project, deletedAt: now })),
      };
      expect(
        yield* decideOrchestrationCommand({
          readModel: deletedProject,
          command: { ...taskCreate, taskId: TaskId.make("new") },
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
    }),
  );
  it.effect(
    "accepts explicit task membership at creation and refuses primary-project deletion even with force",
    () =>
      Effect.gen(function* () {
        let model = yield* seed;
        ({ model } = yield* apply(model, {
          ...threadCreate,
          threadId: ThreadId.make("new-member"),
          taskId,
        }));
        expect(model.threads[1]?.taskId).toBe(taskId);
        for (const archivedAt of [null, now]) {
          const readModel = {
            ...model,
            tasks: model.tasks.map((task) => ({ ...task, archivedAt })),
          };
          expect(
            yield* decideOrchestrationCommand({
              readModel,
              command: { type: "project.delete", commandId, projectId, force: true },
            }).pipe(Effect.flip),
          ).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
        }
        ({ model } = yield* apply(model, {
          type: "project.delete",
          commandId,
          projectId: foreignProjectId,
          force: true,
        }));
        expect(model.tasks[0]?.deletedAt).toBe(null);
        expect(model.threads.every((thread) => thread.deletedAt !== null)).toBe(true);
      }),
  );
});

it.layer(NodeServices.layer)("task lifecycle", (it) => {
  const memberSeed = Effect.gen(function* () {
    const model = yield* seed;
    return (yield* apply(model, { type: "thread.task.set", commandId, threadId, taskId })).model;
  });

  it.effect("settles all members atomically and reopens only the task", () =>
    Effect.gen(function* () {
      let model = yield* memberSeed;
      ({ model } = yield* apply(model, { type: "task.pin", commandId, taskId, orderKey: "a" }));
      const result = yield* apply(model, { type: "task.settle", commandId, taskId });
      expect(result.events.at(-1)?.type).toBe("task.settled");
      expect(result.model.tasks[0]).toMatchObject({ settledOverride: "settled", pinnedAt: null });
      expect(result.model.threads[0]?.settledOverride).toBe("settled");
      const duplicate = yield* apply(result.model, { type: "task.settle", commandId, taskId });
      expect(duplicate.model.tasks).toEqual(result.model.tasks);
      expect(duplicate.model.threads).toEqual(result.model.threads);
      const reopened = yield* apply(result.model, {
        type: "task.unsettle",
        commandId,
        taskId,
        reason: "user",
      });
      expect(reopened.events.every((event) => event.aggregateKind === "task")).toBe(true);
      expect(reopened.model.tasks[0]?.settledOverride).toBe("active");
      expect(reopened.model.threads[0]?.settledOverride).toBe("settled");
    }),
  );

  it.effect(
    "repairs legacy pinned snoozed settlement companions without churning duplicate stamps",
    () =>
      Effect.gen(function* () {
        const original = yield* memberSeed;
        const parked = {
          settledOverride: "settled" as const,
          settledAt: now,
          pinnedAt: now,
          pinOrderKey: "old-pin",
          snoozedUntil: "2099-01-01T00:00:00.000Z",
          snoozedAt: now,
        };
        const model = {
          ...original,
          tasks: original.tasks.map((task) => ({ ...task, ...parked })),
          threads: original.threads.map((thread) => ({ ...thread, ...parked })),
        };
        const repaired = yield* apply(model, { type: "task.settle", commandId, taskId });
        expect(repaired.events.at(-1)?.aggregateKind).toBe("task");
        expect(repaired.model.tasks[0]).toMatchObject({
          settledAt: now,
          pinnedAt: null,
          pinOrderKey: null,
          snoozedUntil: null,
        });
        expect(repaired.model.threads[0]).toMatchObject({
          settledAt: now,
          pinnedAt: null,
          pinOrderKey: null,
          snoozedUntil: null,
        });
        const duplicate = yield* apply(repaired.model, { type: "task.settle", commandId, taskId });
        expect(duplicate.model.tasks).toEqual(repaired.model.tasks);
        expect(duplicate.model.threads).toEqual(repaired.model.threads);
      }),
  );

  it.effect("checks even already-settled snoozed members for running work", () =>
    Effect.gen(function* () {
      const original = yield* memberSeed;
      const model = {
        ...original,
        threads: original.threads.map((thread) => ({
          ...thread,
          settledOverride: "settled" as const,
          settledAt: now,
          snoozedUntil: "2099-01-01T00:00:00.000Z",
          session: {
            threadId,
            status: "running" as const,
            providerName: "Codex",
            runtimeMode: "full-access" as const,
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        })),
      };
      const rejected = yield* decideOrchestrationCommand({
        readModel: model,
        command: { type: "task.settle", commandId, taskId },
      }).pipe(Effect.flip);
      expect(rejected).toMatchObject({
        _tag: "OrchestrationTaskSettleBlockedError",
        taskId,
        threadId,
      });
      expect(model.tasks[0]?.settledOverride).toBe(null);
    }),
  );

  it.effect(
    "snoozes running work, preserves duplicate stamps and wakes without changing members",
    () =>
      Effect.gen(function* () {
        const original = yield* memberSeed;
        let model = {
          ...original,
          threads: original.threads.map((thread) => ({
            ...thread,
            session: {
              threadId,
              status: "running" as const,
              providerName: "Codex",
              runtimeMode: "full-access" as const,
              activeTurnId: null,
              lastError: null,
              updatedAt: now,
            },
          })),
        };
        const snooze = {
          type: "task.snooze",
          commandId,
          taskId,
          snoozedUntil: "2099-01-01T00:00:00.000Z",
        } as const;
        const result = yield* apply(model, snooze);
        const duplicate = yield* apply(result.model, snooze);
        expect(duplicate.model.tasks).toEqual(result.model.tasks);
        const session = result.model.threads[0]!.session!;
        const repeated = yield* apply(result.model, {
          type: "thread.session.set",
          commandId,
          threadId,
          session,
          createdAt: now,
        });
        expect(repeated.events.every((event) => event.aggregateKind === "thread")).toBe(true);
        expect(repeated.model.tasks[0]?.snoozedUntil).toBe(snooze.snoozedUntil);
        const woke = yield* apply(repeated.model, {
          type: "task.unsnooze",
          commandId,
          taskId,
          reason: "user",
        });
        expect(woke.model.tasks[0]?.snoozedUntil).toBe(null);
        expect(woke.model.threads).toEqual(repeated.model.threads);
        const duplicateWake = yield* apply(woke.model, {
          type: "task.unsnooze",
          commandId,
          taskId,
          reason: "user",
        });
        expect(duplicateWake.model.tasks).toEqual(woke.model.tasks);
        expect(
          yield* decideOrchestrationCommand({
            readModel: woke.model,
            command: { ...snooze, snoozedUntil: "invalid" },
          }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
      }),
  );

  it.effect("archives and restores retained members including a previously archived sibling", () =>
    Effect.gen(function* () {
      let model = yield* memberSeed;
      const second = ThreadId.make("archived-member");
      ({ model } = yield* apply(model, { ...threadCreate, threadId: second, taskId }));
      ({ model } = yield* apply(model, { type: "thread.archive", commandId, threadId: second }));
      const archived = yield* apply(model, { type: "task.archive", commandId, taskId });
      expect(archived.events.map((event) => event.type)).toEqual([
        "thread.archived",
        "task.archived",
      ]);
      const legacyRestore = yield* apply(archived.model, {
        type: "thread.unarchive",
        commandId,
        threadId,
      });
      const restored = yield* apply(legacyRestore.model, {
        type: "task.unarchive",
        commandId,
        taskId,
      });
      expect(restored.events.map((event) => event.type)).toEqual([
        "thread.unarchived",
        "task.unarchived",
      ]);
      expect(restored.model.threads.every((thread) => thread.archivedAt === null)).toBe(true);
      expect(restored.model.tasks[0]?.archivedAt).toBe(null);
    }),
  );

  for (const mode of ["keep", "delete"] as const) {
    it.effect(`deletes task with ${mode} mode including archived members`, () =>
      Effect.gen(function* () {
        let model = yield* memberSeed;
        ({ model } = yield* apply(model, { type: "thread.archive", commandId, threadId }));
        const before = model.threads[0]!;
        const result = yield* apply(model, {
          type: "task.delete",
          commandId,
          taskId,
          threads: mode,
        });
        expect(result.events.at(-1)?.type).toBe("task.deleted");
        expect(result.model.tasks[0]?.deletedAt).not.toBe(null);
        if (mode === "keep")
          expect(result.model.threads[0]).toMatchObject({
            taskId: null,
            archivedAt: before.archivedAt,
            deletedAt: null,
          });
        else expect(result.model.threads[0]?.deletedAt).not.toBe(null);
        const duplicate = yield* apply(result.model, {
          type: "task.delete",
          commandId,
          taskId,
          threads: mode,
        });
        expect(duplicate.model.tasks).toEqual(result.model.tasks);
      }),
    );
  }

  it.effect("rejects member pins and supports task promotion and ordering", () =>
    Effect.gen(function* () {
      let model = yield* memberSeed;
      for (const type of ["thread.pin", "thread.pin.reorder"] as const) {
        expect(
          yield* decideOrchestrationCommand({
            readModel: model,
            command: { type, commandId, threadId, orderKey: "a" },
          }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "OrchestrationCommandInvariantError" });
      }
      ({ model } = yield* apply(model, { type: "task.settle", commandId, taskId }));
      ({ model } = yield* apply(model, { type: "task.pin", commandId, taskId, orderKey: "a" }));
      expect(model.tasks[0]).toMatchObject({ settledOverride: "active", pinOrderKey: "a" });
      ({ model } = yield* apply(model, {
        type: "task.pin.reorder",
        commandId,
        taskId,
        orderKey: "b",
      }));
      expect(model.tasks[0]?.pinOrderKey).toBe("b");
      ({ model } = yield* apply(model, { type: "task.unpin", commandId, taskId }));
      ({ model } = yield* apply(model, {
        type: "task.active.reorder",
        commandId,
        taskId,
        orderKey: "c",
      }));
      expect(model.tasks[0]).toMatchObject({ activeOrderKey: "c", pinnedAt: null });
    }),
  );

  it.effect(
    "wakes parked parents only once and preserves active override order when work resumes",
    () =>
      Effect.gen(function* () {
        let model = yield* memberSeed;
        ({ model } = yield* apply(model, { type: "task.settle", commandId, taskId }));
        const wake = yield* apply(model, {
          type: "thread.unsettle",
          commandId,
          threadId,
          reason: "user",
        });
        expect(wake.events.map((event) => event.aggregateKind)).toEqual(["task", "thread"]);
        expect(wake.model.tasks[0]?.settledOverride).toBe(null);
        const repeated = yield* apply(wake.model, {
          type: "thread.unsettle",
          commandId,
          threadId,
          reason: "user",
        });
        expect(repeated.events.every((event) => event.aggregateKind === "thread")).toBe(true);
        ({ model } = yield* apply(repeated.model, {
          type: "task.unsettle",
          commandId,
          taskId,
          reason: "user",
        }));
        ({ model } = yield* apply(model, {
          type: "task.active.reorder",
          commandId,
          taskId,
          orderKey: "retained",
        }));
        const before = model.tasks[0]!;
        const resumed = yield* apply(model, {
          ...threadCreate,
          threadId: ThreadId.make("new-work"),
          taskId,
        });
        expect(resumed.events.at(-1)?.aggregateKind).toBe("thread");
        expect(resumed.model.tasks[0]).toMatchObject({
          settledOverride: null,
          unsettledAt: before.unsettledAt,
          activeOrderKey: "retained",
        });
      }),
  );

  it.effect("does not wake destinations for parked moves or reorder timer-woken tasks", () =>
    Effect.gen(function* () {
      let model = yield* seed;
      ({ model } = yield* apply(model, { type: "thread.settle", commandId, threadId }));
      ({ model } = yield* apply(model, { type: "task.settle", commandId, taskId }));
      const moved = yield* apply(model, { type: "thread.task.set", commandId, threadId, taskId });
      expect(moved.events.map((event) => event.type)).toEqual(["thread.task-set"]);
      model = {
        ...moved.model,
        tasks: moved.model.tasks.map((task) => ({
          ...task,
          settledOverride: null,
          settledAt: null,
          snoozedUntil: "1969-01-01T00:00:00.000Z",
          snoozedAt: "1968-01-01T00:00:00.000Z",
          activeOrderKey: "keep-slot",
          unsettledAt: now,
        })),
      };
      const resumed = yield* apply(model, {
        type: "thread.unsettle",
        commandId,
        threadId,
        reason: "user",
      });
      expect(resumed.model.tasks[0]).toMatchObject({
        activeOrderKey: "keep-slot",
        unsettledAt: now,
        snoozedUntil: null,
      });
    }),
  );
});

const resultAt = "2026-01-02T00:00:00.000Z";
const wakeAt = "2026-02-01T00:00:00.000Z";
const resultTurnId = TurnId.make("result-turn");

it.layer(NodeServices.layer)("task result wake and membership activity", (it) => {
  const memberSeed = Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(now));
    const model = yield* seed;
    return (yield* apply(model, { type: "thread.task.set", commandId, threadId, taskId })).model;
  });
  it.effect("a fresh error wakes snooze without rewinding the task settlement anchor", () =>
    Effect.gen(function* () {
      let model = yield* memberSeed;
      ({ model } = yield* apply(model, { type: "thread.settle", commandId, threadId }));
      ({ model } = yield* apply(model, {
        type: "task.snooze",
        commandId,
        taskId,
        snoozedUntil: wakeAt,
      }));
      const latestActivityAt = "2026-01-03T00:00:00.000Z";
      yield* TestClock.setTime(Date.parse(latestActivityAt));
      ({ model } = yield* apply(model, {
        type: "task.meta.update",
        commandId,
        taskId,
        name: "Updated while snoozed",
      }));
      const result = yield* apply(model, {
        type: "thread.session.set",
        commandId,
        threadId,
        createdAt: latestActivityAt,
        session: {
          threadId,
          status: "error",
          providerName: "Codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "Delayed failure",
          updatedAt: resultAt,
        },
      });
      expect(result.events.map((event) => event.type)).toEqual([
        "task.unsettled",
        "task.unsnoozed",
        "thread.session-set",
      ]);
      for (const event of result.events.slice(0, 2)) {
        expect(event.occurredAt).toBe(resultAt);
        expect(event.payload).toMatchObject({ updatedAt: latestActivityAt });
      }
      expect(result.model.tasks[0]).toMatchObject({
        snoozedUntil: null,
        updatedAt: latestActivityAt,
      });
      const policy = {
        task: result.model.tasks[0]!,
        members: result.model.threads.map((thread) => ({
          ...thread,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
        })),
        settings: { sidebarAutoSettleAfterDays: 3 },
      };
      const oldBoundary = Date.parse(resultAt) + 3 * 86_400_000;
      const boundary = Date.parse(latestActivityAt) + 3 * 86_400_000;
      expect(resolveTaskAutoSettlementAt({ ...policy, nowMs: oldBoundary + 1 })).toBeNull();
      expect(resolveTaskAutoSettlementAt({ ...policy, nowMs: boundary })).toBeNull();
      expect(resolveTaskAutoSettlementAt({ ...policy, nowMs: boundary + 1 })).toBe(
        latestActivityAt,
      );
    }),
  );
  for (const activityAt of [now, resultAt]) {
    it.effect(
      `membership at ${activityAt} omits unchanged metadata and retains wake companions`,
      () =>
        Effect.gen(function* () {
          let model = yield* memberSeed;
          const otherTaskId = TaskId.make("other-task");
          ({ model } = yield* apply(model, { ...taskCreate, taskId: otherTaskId }));
          model = {
            ...model,
            tasks: model.tasks.map((task) => ({ ...task, updatedAt: resultAt })),
          };
          yield* TestClock.setTime(Date.parse(activityAt));
          for (const command of [
            { type: "thread.task.set", commandId, threadId, taskId: null },
            { type: "thread.task.set", commandId, threadId, taskId: otherTaskId },
            { type: "thread.archive", commandId, threadId },
            { type: "thread.delete", commandId, threadId },
            {
              ...threadCreate,
              threadId: ThreadId.make("created-member"),
              taskId,
              createdAt: activityAt,
            },
          ] satisfies OrchestrationCommand[]) {
            const result = yield* apply(model, command);
            expect(result.events).toHaveLength(1);
            expect(result.events[0]?.aggregateKind).toBe("thread");
            expect(result.model.tasks).toEqual(model.tasks);
          }
          const parked = {
            ...model,
            tasks: model.tasks.map((task) => ({
              ...task,
              snoozedAt: now,
              snoozedUntil: wakeAt,
            })),
          };
          const resumed = yield* apply(parked, {
            ...threadCreate,
            threadId: ThreadId.make("resumed-member"),
            taskId,
            createdAt: activityAt,
          });
          expect(resumed.events.map((event) => event.type)).toEqual([
            "task.unsettled",
            "task.unsnoozed",
            "thread.created",
          ]);
          expect(resumed.model.tasks[0]).toMatchObject({ updatedAt: resultAt, snoozedUntil: null });
          for (const event of resumed.events.slice(0, 2)) {
            expect(event.occurredAt).toBe(activityAt);
            expect(event.payload).toMatchObject({ updatedAt: resultAt });
          }
        }),
    );
  }
  for (const lifecycle of ["archived", "deleted"] as const) {
    it.effect(`${lifecycle} tasks receive no membership activity`, () =>
      Effect.gen(function* () {
        const original = yield* memberSeed;
        const model = {
          ...original,
          tasks: original.tasks.map((task) => ({
            ...task,
            archivedAt: lifecycle === "archived" ? now : null,
            deletedAt: lifecycle === "deleted" ? now : null,
          })),
        };
        yield* TestClock.setTime(Date.parse(resultAt));
        for (const command of [
          { type: "thread.task.set", commandId, threadId, taskId: null },
          { type: "thread.archive", commandId, threadId },
          { type: "thread.delete", commandId, threadId },
        ] satisfies OrchestrationCommand[]) {
          const result = yield* apply(model, command);
          expect(result.events).toHaveLength(1);
          expect(result.model.tasks).toEqual(model.tasks);
        }
        const restored = yield* apply(
          { ...model, threads: model.threads.map((thread) => ({ ...thread, archivedAt: now })) },
          { type: "thread.unarchive", commandId, threadId },
        );
        expect(restored.events.map((event) => event.type)).toEqual(["thread.unarchived"]);
        expect(restored.model.tasks).toEqual(model.tasks);
      }),
    );
  }
  for (const kind of ["error", "checkpoint", "session-completion"] as const) {
    for (const snoozedAt of [now, resultAt, wakeAt, null]) {
      it.effect(`${kind} compares its effective result timestamp with snooze ${snoozedAt}`, () =>
        Effect.gen(function* () {
          const original = yield* memberSeed;
          const model = {
            ...original,
            tasks: original.tasks.map((task) => ({ ...task, snoozedAt, snoozedUntil: wakeAt })),
            threads: original.threads.map((thread) => ({
              ...thread,
              latestTurn: {
                turnId: resultTurnId,
                state: "running" as const,
                requestedAt: now,
                startedAt: now,
                completedAt: null,
                assistantMessageId: null,
              },
            })),
          };
          const command: OrchestrationCommand =
            kind === "checkpoint"
              ? {
                  type: "thread.turn.diff.complete",
                  commandId,
                  threadId,
                  turnId: resultTurnId,
                  checkpointTurnCount: 1,
                  checkpointRef: CheckpointRef.make("refs/checkpoints/result"),
                  status: "ready",
                  files: [],
                  completedAt: resultAt,
                  createdAt: "2026-01-20T00:00:00.000Z",
                }
              : {
                  type: "thread.session.set",
                  commandId,
                  threadId,
                  createdAt: "2026-01-20T00:00:00.000Z",
                  session: {
                    threadId,
                    status: kind === "error" ? "error" : "ready",
                    providerName: "Codex",
                    runtimeMode: "full-access",
                    activeTurnId: null,
                    lastError: null,
                    updatedAt: resultAt,
                  },
                };
          const result = yield* apply(model, command);
          const wakes = snoozedAt === now || (snoozedAt === null && kind === "error");
          expect(result.model.tasks[0]?.snoozedUntil).toBe(wakes ? null : wakeAt);
          expect(result.events.at(-1)?.aggregateKind).toBe("thread");
          expect(result.model.threads[0]?.settledOverride).toBe(model.threads[0]?.settledOverride);
          expect(result.model.threads[0]?.snoozedUntil).toBe(model.threads[0]?.snoozedUntil);
          if (wakes) {
            expect(result.events.slice(0, -1).map((event) => event.type)).toEqual([
              "task.unsettled",
              "task.unsnoozed",
            ]);
            expect(result.model.tasks[0]?.updatedAt).toBe(resultAt);
            yield* TestClock.setTime(Date.parse("2026-01-03T00:00:00.000Z"));
            const snoozed = yield* apply(result.model, {
              type: "task.snooze",
              commandId,
              taskId,
              snoozedUntil: wakeAt,
            });
            const duplicate = yield* apply(snoozed.model, command);
            expect(duplicate.model.tasks).toEqual(snoozed.model.tasks);
          }
          for (const state of [
            "settled",
            "active",
            "archived-member",
            "deleted-member",
            "archived-task",
            "deleted-task",
            "expired",
          ] as const) {
            const guarded = {
              ...model,
              tasks: model.tasks.map((task) => ({
                ...task,
                settledOverride: state === "settled" ? ("settled" as const) : null,
                snoozedUntil: state === "active" ? null : state === "expired" ? resultAt : wakeAt,
                archivedAt: state === "archived-task" ? now : null,
                deletedAt: state === "deleted-task" ? now : null,
                activeOrderKey: "saved",
              })),
              threads: model.threads.map((thread) => ({
                ...thread,
                archivedAt: state === "archived-member" ? now : null,
                deletedAt: state === "deleted-member" ? now : null,
              })),
            };
            expect((yield* apply(guarded, command)).model.tasks).toEqual(guarded.tasks);
          }
        }),
      );
    }
  }
  it.effect(
    "ignores non-current, interrupted, failed, running and superseded placeholder checkpoints",
    () =>
      Effect.gen(function* () {
        const original = yield* memberSeed;
        const command = {
          type: "thread.turn.diff.complete",
          commandId,
          threadId,
          turnId: resultTurnId,
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.make("refs/checkpoints/result"),
          status: "ready",
          files: [],
          completedAt: resultAt,
          createdAt: resultAt,
        } as const;
        for (const scenario of [
          "other-turn",
          "interrupted",
          "error",
          "running",
          "placeholder",
        ] as const) {
          const model = {
            ...original,
            tasks: original.tasks.map((task) => ({
              ...task,
              snoozedAt: now,
              snoozedUntil: wakeAt,
            })),
            threads: original.threads.map((thread) => ({
              ...thread,
              latestTurn: {
                turnId: scenario === "other-turn" ? TurnId.make("new-turn") : resultTurnId,
                state: scenario === "interrupted" ? ("interrupted" as const) : ("running" as const),
                requestedAt: now,
                startedAt: now,
                completedAt: null,
                assistantMessageId: null,
              },
              session:
                scenario === "running"
                  ? {
                      threadId,
                      status: "running" as const,
                      providerName: "Codex",
                      runtimeMode: "full-access" as const,
                      activeTurnId: resultTurnId,
                      lastError: null,
                      updatedAt: now,
                    }
                  : null,
              checkpoints:
                scenario === "placeholder"
                  ? [
                      {
                        turnId: resultTurnId,
                        checkpointTurnCount: 1,
                        checkpointRef: command.checkpointRef,
                        status: "ready" as const,
                        files: [],
                        completedAt: now,
                        assistantMessageId: null,
                      },
                    ]
                  : [],
            })),
          };
          const result = yield* apply(model, {
            ...command,
            status:
              scenario === "error" ? "error" : scenario === "placeholder" ? "missing" : "ready",
          });
          expect(result.model.tasks).toEqual(model.tasks);
        }
      }),
  );
  for (const operation of [
    "remove",
    "add-parked",
    "move",
    "archive",
    "unarchive",
    "delete",
    "create",
  ] as const) {
    it.effect(
      `${operation} persists membership activity and restarts the complete inactivity window`,
      () =>
        Effect.gen(function* () {
          let model = yield* memberSeed;
          const otherTaskId = TaskId.make("other-task");
          ({ model } = yield* apply(model, { ...taskCreate, taskId: otherTaskId }));
          ({ model } = yield* apply(model, { type: "thread.settle", commandId, threadId }));
          if (operation === "add-parked")
            ({ model } = yield* apply(model, {
              type: "thread.task.set",
              commandId,
              threadId,
              taskId: null,
            }));
          if (operation === "unarchive")
            ({ model } = yield* apply(model, { type: "thread.archive", commandId, threadId }));
          yield* TestClock.setTime(Date.parse(resultAt));
          const command: OrchestrationCommand =
            operation === "create"
              ? {
                  ...threadCreate,
                  threadId: ThreadId.make("created-member"),
                  taskId,
                  createdAt: resultAt,
                }
              : operation === "remove" || operation === "add-parked" || operation === "move"
                ? {
                    type: "thread.task.set",
                    commandId,
                    threadId,
                    taskId:
                      operation === "remove" ? null : operation === "move" ? otherTaskId : taskId,
                  }
                : {
                    type:
                      operation === "archive"
                        ? "thread.archive"
                        : operation === "unarchive"
                          ? "thread.unarchive"
                          : "thread.delete",
                    commandId,
                    threadId,
                  };
          const before = model.tasks;
          const result = yield* apply(model, command);
          expect(result.events.at(-1)?.aggregateKind).toBe("thread");
          const affected =
            operation === "move"
              ? result.model.tasks
              : result.model.tasks.filter((task) => task.id === taskId);
          for (const task of affected) {
            expect(task).toEqual({
              ...before.find((previous) => previous.id === task.id),
              updatedAt: resultAt,
            });
            const members = result.model.threads
              .filter((thread) => thread.taskId === task.id && thread.deletedAt === null)
              .map((thread) => ({
                ...thread,
                latestUserMessageAt: null,
                hasPendingApprovals: false,
                hasPendingUserInput: false,
              }));
            if (operation === "create") continue; // Newly created live work independently blocks settlement.
            const policy = { task, members, settings: { sidebarAutoSettleAfterDays: 3 } };
            const boundary = Date.parse(resultAt) + 3 * 86_400_000;
            expect(
              resolveTaskAutoSettlementAt({ ...policy, nowMs: Date.parse(resultAt) }),
            ).toBeNull();
            expect(resolveTaskAutoSettlementAt({ ...policy, nowMs: boundary })).toBeNull();
            expect(resolveTaskAutoSettlementAt({ ...policy, nowMs: boundary + 1 })).toBe(resultAt);
            expect(
              resolveTaskAutoSettlementAt({
                ...policy,
                nowMs: boundary + 1,
                settings: { sidebarAutoSettleAfterDays: null },
              }),
            ).toBeNull();
            expect(
              resolveTaskAutoSettlementAt({
                ...policy,
                nowMs: boundary + 1,
                task: { ...task, settledOverride: "active" },
              }),
            ).toBeNull();
          }
        }),
    );
  }
  it.effect(
    "idempotent assignment and ordering leave activity unchanged; delayed creation cannot regress it",
    () =>
      Effect.gen(function* () {
        let model = yield* memberSeed;
        yield* TestClock.setTime(Date.parse(resultAt));
        const duplicate = yield* apply(model, {
          type: "thread.task.set",
          commandId,
          threadId,
          taskId,
        });
        expect(duplicate.events.map((event) => event.type)).toEqual(["thread.task-set"]);
        expect(duplicate.model.tasks).toEqual(model.tasks);
        ({ model } = yield* apply(model, {
          type: "task.unsettle",
          commandId,
          taskId,
          reason: "user",
        }));
        ({ model } = yield* apply(model, {
          type: "task.active.reorder",
          commandId,
          taskId,
          orderKey: "saved",
        }));
        const before = model.tasks[0]!;
        yield* TestClock.setTime(Date.parse(wakeAt));
        const reordered = yield* apply(model, {
          type: "task.active.reorder",
          commandId,
          taskId,
          orderKey: "next",
        });
        expect(reordered.model.tasks[0]?.updatedAt).toBe(before.updatedAt);
        const delayed = yield* apply(model, {
          ...threadCreate,
          threadId: ThreadId.make("delayed"),
          taskId,
          createdAt: now,
        });
        expect(delayed.model.tasks[0]?.updatedAt).toBe(before.updatedAt);
        const parked = {
          ...model,
          threads: model.threads.map((thread) => ({
            ...thread,
            settledOverride: "settled" as const,
          })),
        };
        const removed = yield* apply(parked, {
          type: "thread.task.set",
          commandId,
          threadId,
          taskId: null,
        });
        expect(removed.model.tasks[0]).toEqual({ ...before, updatedAt: wakeAt });
      }),
  );
});
