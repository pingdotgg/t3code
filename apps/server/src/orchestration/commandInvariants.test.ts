import { describe, expect, it } from "vitest";
import {
  MessageId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";

import {
  findThreadById,
  listThreadsByProjectId,
  requireNonNegativeInteger,
  requireProjectDeletionArchivedThreads,
  requireThread,
  requireThreadAbsent,
} from "./commandInvariants.ts";

const now = new Date().toISOString();

const readModel: OrchestrationReadModel = {
  snapshotSequence: 2,
  updatedAt: now,
  projects: [
    {
      id: ProjectId.make("project-a"),
      title: "Project A",
      workspaceRoot: "/tmp/project-a",
      defaultModelSelection: {
        provider: "codex",
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
        provider: "codex",
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
        provider: "codex",
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
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
    },
    {
      id: ThreadId.make("thread-2"),
      projectId: ProjectId.make("project-b"),
      title: "Thread B",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
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

const projectDeleteCommand: OrchestrationCommand = {
  type: "project.delete",
  commandId: CommandId.make("cmd-project-delete"),
  projectId: ProjectId.make("project-a"),
};

describe("commandInvariants", () => {
  it("finds threads by id and project", () => {
    expect(findThreadById(readModel, ThreadId.make("thread-1"))?.projectId).toBe("project-a");
    expect(findThreadById(readModel, ThreadId.make("missing"))).toBeUndefined();
    expect(
      listThreadsByProjectId(readModel, ProjectId.make("project-b")).map((thread) => thread.id),
    ).toEqual([ThreadId.make("thread-2")]);
  });

  it("requires existing thread", async () => {
    const thread = await Effect.runPromise(
      requireThread({
        readModel,
        command: messageSendCommand,
        threadId: ThreadId.make("thread-1"),
      }),
    );
    expect(thread.id).toBe(ThreadId.make("thread-1"));

    await expect(
      Effect.runPromise(
        requireThread({
          readModel,
          command: messageSendCommand,
          threadId: ThreadId.make("missing"),
        }),
      ),
    ).rejects.toThrow("does not exist");
  });

  it("requires missing thread for create flows", async () => {
    await Effect.runPromise(
      requireThreadAbsent({
        readModel,
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-2"),
          threadId: ThreadId.make("thread-3"),
          projectId: ProjectId.make("project-a"),
          title: "new",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        threadId: ThreadId.make("thread-3"),
      }),
    );

    await expect(
      Effect.runPromise(
        requireThreadAbsent({
          readModel,
          command: {
            type: "thread.create",
            commandId: CommandId.make("cmd-3"),
            threadId: ThreadId.make("thread-1"),
            projectId: ProjectId.make("project-a"),
            title: "dup",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
          threadId: ThreadId.make("thread-1"),
        }),
      ),
    ).rejects.toThrow("already exists");
  });

  it("requires non-negative integers", async () => {
    await Effect.runPromise(
      requireNonNegativeInteger({
        commandType: "thread.checkpoint.revert",
        field: "turnCount",
        value: 0,
      }),
    );

    await expect(
      Effect.runPromise(
        requireNonNegativeInteger({
          commandType: "thread.checkpoint.revert",
          field: "turnCount",
          value: -1,
        }),
      ),
    ).rejects.toThrow("greater than or equal to 0");
  });

  it("rejects project deletion when active threads still exist", async () => {
    await expect(
      Effect.runPromise(
        requireProjectDeletionArchivedThreads({
          readModel,
          command: projectDeleteCommand,
          projectId: ProjectId.make("project-a"),
        }),
      ),
    ).rejects.toThrow("still has active threads");
  });

  it("allows project deletion when only archived threads remain", async () => {
    const archivedOnlyReadModel: OrchestrationReadModel = {
      ...readModel,
      threads: readModel.threads
        .filter((thread) => thread.projectId !== ProjectId.make("project-a"))
        .concat({
          ...readModel.threads[0]!,
          id: ThreadId.make("thread-archived-only"),
          projectId: ProjectId.make("project-a"),
          archivedAt: now,
        }),
    };

    await expect(
      Effect.runPromise(
        requireProjectDeletionArchivedThreads({
          readModel: archivedOnlyReadModel,
          command: projectDeleteCommand,
          projectId: ProjectId.make("project-a"),
        }),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        id: ThreadId.make("thread-archived-only"),
        projectId: ProjectId.make("project-a"),
        archivedAt: now,
      }),
    ]);
  });

  it("returns only archived threads for the target project", async () => {
    const targetArchivedAt = "2026-03-10T00:00:00.000Z";
    const archivedOnlyReadModel: OrchestrationReadModel = {
      ...readModel,
      threads: [
        {
          ...readModel.threads[0]!,
          id: ThreadId.make("thread-archived-target"),
          projectId: ProjectId.make("project-a"),
          archivedAt: targetArchivedAt,
        },
        {
          ...readModel.threads[1]!,
          id: ThreadId.make("thread-archived-other"),
          projectId: ProjectId.make("project-b"),
          archivedAt: "2026-03-11T00:00:00.000Z",
        },
      ],
    };

    const archivedThreads = await Effect.runPromise(
      requireProjectDeletionArchivedThreads({
        readModel: archivedOnlyReadModel,
        command: projectDeleteCommand,
        projectId: ProjectId.make("project-a"),
      }),
    );

    expect(archivedThreads).toEqual([
      expect.objectContaining({
        id: ThreadId.make("thread-archived-target"),
        projectId: ProjectId.make("project-a"),
        archivedAt: targetArchivedAt,
      }),
    ]);
  });
});
