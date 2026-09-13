import {
  CommandId,
  ProjectId,
  TaskId,
  ThreadId,
  ProviderInstanceId,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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
