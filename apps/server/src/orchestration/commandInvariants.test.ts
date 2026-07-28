import { assert, it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import {
  MessageId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  findThreadById,
  listThreadsByProjectId,
  requireNonNegativeInteger,
  requireProject,
  requireProjectIncludingDeleted,
  requireThread,
  requireThreadAbsent,
  requireThreadIncludingDeleted,
  requireValidParentThread,
} from "./commandInvariants.ts";

const now = "2026-01-01T00:00:00.000Z";

const readModel: OrchestrationReadModel = {
  snapshotSequence: 2,
  updatedAt: now,
  projects: [
    {
      id: ProjectId.make("project-a"),
      title: "Project A",
      workspaceRoot: "/tmp/project-a",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: ProjectId.make("project-b"),
      title: "Project B",
      workspaceRoot: "/tmp/project-b",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  threads: [
    {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-a"),
      title: "Thread A",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      executorModelSelection: null,
      executorMaxSubAgents: 3,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      parentThreadId: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
      autoReviewPhase: null,
    },
    {
      id: ThreadId.make("thread-2"),
      projectId: ProjectId.make("project-b"),
      title: "Thread B",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      executorModelSelection: null,
      executorMaxSubAgents: 3,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      parentThreadId: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
      autoReviewPhase: null,
    },
  ],
};

const messageSendCommand: OrchestrationCommand = {
  type: "thread.turn.start",
  commandId: CommandId.make("cmd-1"),
  threadId: ThreadId.make("thread-1"),
  message: {
    messageId: MessageId.make("msg-1"),
    role: "user",
    text: "hello",
    attachments: [],
  },
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "approval-required",
  createdAt: now,
};

describe("commandInvariants", () => {
  it("finds threads by id and project", () => {
    expect(findThreadById(readModel, ThreadId.make("thread-1"))?.projectId).toBe("project-a");
    expect(findThreadById(readModel, ThreadId.make("missing"))).toBeUndefined();
    expect(
      listThreadsByProjectId(readModel, ProjectId.make("project-b")).map((thread) => thread.id),
    ).toEqual([ThreadId.make("thread-2")]);
  });

  it.effect("requires existing thread", () =>
    Effect.gen(function* () {
      const thread = yield* requireThread({
        readModel,
        command: messageSendCommand,
        threadId: ThreadId.make("thread-1"),
      });
      expect(thread.id).toBe(ThreadId.make("thread-1"));

      const missingError = yield* Effect.flip(
        requireThread({
          readModel,
          command: messageSendCommand,
          threadId: ThreadId.make("missing"),
        }),
      );
      assert.include(missingError.detail, "does not exist");
    }),
  );

  it.effect("rejects deleted aggregates except for explicit delete flows", () =>
    Effect.gen(function* () {
      const deletedAt = "2026-01-02T00:00:00.000Z";
      const tombstonedReadModel: OrchestrationReadModel = {
        ...readModel,
        projects: readModel.projects.map((project) =>
          project.id === ProjectId.make("project-a") ? { ...project, deletedAt } : project,
        ),
        threads: readModel.threads.map((thread) =>
          thread.id === ThreadId.make("thread-1") ? { ...thread, deletedAt } : thread,
        ),
      };
      const projectDeleteCommand: OrchestrationCommand = {
        type: "project.delete",
        commandId: CommandId.make("cmd-delete-project-tombstone"),
        projectId: ProjectId.make("project-a"),
      };
      const threadDeleteCommand: OrchestrationCommand = {
        type: "thread.delete",
        commandId: CommandId.make("cmd-delete-thread-tombstone"),
        threadId: ThreadId.make("thread-1"),
      };

      const deletedProjectError = yield* Effect.flip(
        requireProject({
          readModel: tombstonedReadModel,
          command: projectDeleteCommand,
          projectId: ProjectId.make("project-a"),
        }),
      );
      assert.include(deletedProjectError.detail, "has been deleted");

      const deletedThreadError = yield* Effect.flip(
        requireThread({
          readModel: tombstonedReadModel,
          command: messageSendCommand,
          threadId: ThreadId.make("thread-1"),
        }),
      );
      assert.include(deletedThreadError.detail, "has been deleted");

      const deletedProject = yield* requireProjectIncludingDeleted({
        readModel: tombstonedReadModel,
        command: projectDeleteCommand,
        projectId: ProjectId.make("project-a"),
      });
      expect(deletedProject.deletedAt).toBe(deletedAt);

      const deletedThread = yield* requireThreadIncludingDeleted({
        readModel: tombstonedReadModel,
        command: threadDeleteCommand,
        threadId: ThreadId.make("thread-1"),
      });
      expect(deletedThread.deletedAt).toBe(deletedAt);
    }),
  );

  it.effect("requires missing thread for create flows", () =>
    Effect.gen(function* () {
      yield* requireThreadAbsent({
        readModel,
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-2"),
          threadId: ThreadId.make("thread-3"),
          projectId: ProjectId.make("project-a"),
          title: "new",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          parentThreadId: null,
          createdAt: now,
        },
        threadId: ThreadId.make("thread-3"),
      });

      const duplicateError = yield* Effect.flip(
        requireThreadAbsent({
          readModel,
          command: {
            type: "thread.create",
            commandId: CommandId.make("cmd-3"),
            threadId: ThreadId.make("thread-1"),
            projectId: ProjectId.make("project-a"),
            title: "dup",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            parentThreadId: null,
            createdAt: now,
          },
          threadId: ThreadId.make("thread-1"),
        }),
      );
      assert.include(duplicateError.detail, "already exists");
    }),
  );

  it.effect("validates parentThreadId on create flows", () =>
    Effect.gen(function* () {
      const createCommand = (threadId: string, parentThreadId: string): OrchestrationCommand => ({
        type: "thread.create",
        commandId: CommandId.make("cmd-parent"),
        threadId: ThreadId.make(threadId),
        projectId: ProjectId.make("project-a"),
        title: "child",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        parentThreadId: ThreadId.make(parentThreadId),
        createdAt: now,
      });

      // Existing same-project parent passes.
      yield* requireValidParentThread({
        readModel,
        command: createCommand("thread-3", "thread-1"),
        threadId: ThreadId.make("thread-3"),
        projectId: ProjectId.make("project-a"),
        parentThreadId: ThreadId.make("thread-1"),
      });

      // Self-parent is rejected.
      const selfParentError = yield* Effect.flip(
        requireValidParentThread({
          readModel,
          command: createCommand("thread-3", "thread-3"),
          threadId: ThreadId.make("thread-3"),
          projectId: ProjectId.make("project-a"),
          parentThreadId: ThreadId.make("thread-3"),
        }),
      );
      assert.include(selfParentError.detail, "cannot be its own parent");

      // Unknown parent is rejected.
      const missingParentError = yield* Effect.flip(
        requireValidParentThread({
          readModel,
          command: createCommand("thread-3", "thread-missing"),
          threadId: ThreadId.make("thread-3"),
          projectId: ProjectId.make("project-a"),
          parentThreadId: ThreadId.make("thread-missing"),
        }),
      );
      assert.include(missingParentError.detail, "does not exist");

      // Deleted parents are tombstones, not valid graph edges.
      const deletedParentReadModel: OrchestrationReadModel = {
        ...readModel,
        threads: readModel.threads.map((thread) =>
          thread.id === ThreadId.make("thread-1")
            ? { ...thread, deletedAt: "2026-01-02T00:00:00.000Z" }
            : thread,
        ),
      };
      const deletedParentError = yield* Effect.flip(
        requireValidParentThread({
          readModel: deletedParentReadModel,
          command: createCommand("thread-3", "thread-1"),
          threadId: ThreadId.make("thread-3"),
          projectId: ProjectId.make("project-a"),
          parentThreadId: ThreadId.make("thread-1"),
        }),
      );
      assert.include(deletedParentError.detail, "has been deleted");

      // Cross-project parent is rejected.
      const crossProjectError = yield* Effect.flip(
        requireValidParentThread({
          readModel,
          command: createCommand("thread-3", "thread-2"),
          threadId: ThreadId.make("thread-3"),
          projectId: ProjectId.make("project-a"),
          parentThreadId: ThreadId.make("thread-2"),
        }),
      );
      assert.include(crossProjectError.detail, "belongs to project");
    }),
  );

  it.effect("requires non-negative integers", () =>
    Effect.gen(function* () {
      yield* requireNonNegativeInteger({
        commandType: "thread.checkpoint.revert",
        field: "turnCount",
        value: 0,
      });

      const negativeError = yield* Effect.flip(
        requireNonNegativeInteger({
          commandType: "thread.checkpoint.revert",
          field: "turnCount",
          value: -1,
        }),
      );
      assert.include(negativeError.detail, "greater than or equal to 0");
    }),
  );
});
