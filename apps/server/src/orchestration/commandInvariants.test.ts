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
  findProjectByWorkspaceRoot,
  findThreadById,
  listThreadsByProjectId,
  requireNonNegativeInteger,
  requireThread,
  requireThreadAbsent,
  requireWorkspaceRootUnique,
} from "./commandInvariants.ts";

const now = new Date().toISOString();

const readModel: OrchestrationReadModel = {
  snapshotSequence: 2,
  updatedAt: now,
  projects: [
    {
      id: ProjectId.makeUnsafe("project-a"),
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
      id: ProjectId.makeUnsafe("project-b"),
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
    {
      id: ProjectId.makeUnsafe("project-deleted"),
      title: "Deleted Project",
      workspaceRoot: "/tmp/project-deleted",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: now,
    },
  ],
  threads: [
    {
      id: ThreadId.makeUnsafe("thread-1"),
      projectId: ProjectId.makeUnsafe("project-a"),
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
      id: ThreadId.makeUnsafe("thread-2"),
      projectId: ProjectId.makeUnsafe("project-b"),
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
  commandId: CommandId.makeUnsafe("cmd-1"),
  threadId: ThreadId.makeUnsafe("thread-1"),
  message: {
    messageId: MessageId.makeUnsafe("msg-1"),
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
    expect(findThreadById(readModel, ThreadId.makeUnsafe("thread-1"))?.projectId).toBe("project-a");
    expect(findThreadById(readModel, ThreadId.makeUnsafe("missing"))).toBeUndefined();
    expect(
      listThreadsByProjectId(readModel, ProjectId.makeUnsafe("project-b")).map(
        (thread) => thread.id,
      ),
    ).toEqual([ThreadId.makeUnsafe("thread-2")]);
  });

  it("requires existing thread", async () => {
    const thread = await Effect.runPromise(
      requireThread({
        readModel,
        command: messageSendCommand,
        threadId: ThreadId.makeUnsafe("thread-1"),
      }),
    );
    expect(thread.id).toBe(ThreadId.makeUnsafe("thread-1"));

    await expect(
      Effect.runPromise(
        requireThread({
          readModel,
          command: messageSendCommand,
          threadId: ThreadId.makeUnsafe("missing"),
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
          commandId: CommandId.makeUnsafe("cmd-2"),
          threadId: ThreadId.makeUnsafe("thread-3"),
          projectId: ProjectId.makeUnsafe("project-a"),
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
        threadId: ThreadId.makeUnsafe("thread-3"),
      }),
    );

    await expect(
      Effect.runPromise(
        requireThreadAbsent({
          readModel,
          command: {
            type: "thread.create",
            commandId: CommandId.makeUnsafe("cmd-3"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            projectId: ProjectId.makeUnsafe("project-a"),
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
          threadId: ThreadId.makeUnsafe("thread-1"),
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

  it("finds non-deleted project by workspaceRoot", () => {
    expect(findProjectByWorkspaceRoot(readModel, "/tmp/project-a")?.id).toBe("project-a");
    expect(findProjectByWorkspaceRoot(readModel, "/tmp/missing")).toBeUndefined();
    expect(findProjectByWorkspaceRoot(readModel, "/tmp/project-deleted")).toBeUndefined();
  });

  it("requires unique workspaceRoot for project creation", async () => {
    const createCommand: OrchestrationCommand = {
      type: "project.create",
      commandId: CommandId.makeUnsafe("cmd-create"),
      projectId: ProjectId.makeUnsafe("project-new"),
      title: "New Project",
      workspaceRoot: "/tmp/project-new",
      createdAt: now,
    };

    await Effect.runPromise(
      requireWorkspaceRootUnique({
        readModel,
        command: createCommand,
        workspaceRoot: "/tmp/project-new",
      }),
    );

    await expect(
      Effect.runPromise(
        requireWorkspaceRootUnique({
          readModel,
          command: createCommand,
          workspaceRoot: "/tmp/project-a",
        }),
      ),
    ).rejects.toThrow("already used by project");

    await Effect.runPromise(
      requireWorkspaceRootUnique({
        readModel,
        command: createCommand,
        workspaceRoot: "/tmp/project-deleted",
      }),
    );
  });

  it("requires unique workspaceRoot for project update, excluding self", async () => {
    const updateCommand: OrchestrationCommand = {
      type: "project.meta.update",
      commandId: CommandId.makeUnsafe("cmd-update"),
      projectId: ProjectId.makeUnsafe("project-a"),
      workspaceRoot: "/tmp/project-a",
    };

    await Effect.runPromise(
      requireWorkspaceRootUnique({
        readModel,
        command: updateCommand,
        workspaceRoot: "/tmp/project-a",
        excludeProjectId: ProjectId.makeUnsafe("project-a"),
      }),
    );

    await expect(
      Effect.runPromise(
        requireWorkspaceRootUnique({
          readModel,
          command: updateCommand,
          workspaceRoot: "/tmp/project-b",
          excludeProjectId: ProjectId.makeUnsafe("project-a"),
        }),
      ),
    ).rejects.toThrow("already used by project");

    await Effect.runPromise(
      requireWorkspaceRootUnique({
        readModel,
        command: updateCommand,
        workspaceRoot: "/tmp/project-new-path",
        excludeProjectId: ProjectId.makeUnsafe("project-a"),
      }),
    );
  });

  it("allows self-update when pre-existing duplicates place excluded project later in array", async () => {
    const duplicateReadModel: OrchestrationReadModel = {
      ...readModel,
      projects: [
        {
          id: ProjectId.makeUnsafe("project-dup-1"),
          title: "Dup 1",
          workspaceRoot: "/tmp/shared-root",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        },
        {
          id: ProjectId.makeUnsafe("project-dup-2"),
          title: "Dup 2",
          workspaceRoot: "/tmp/shared-root",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        },
      ],
    };

    const updateCommand: OrchestrationCommand = {
      type: "project.meta.update",
      commandId: CommandId.makeUnsafe("cmd-update-dup"),
      projectId: ProjectId.makeUnsafe("project-dup-2"),
      title: "Renamed",
    };

    // project-dup-2 updates its own workspaceRoot - should detect project-dup-1 as a conflict
    await expect(
      Effect.runPromise(
        requireWorkspaceRootUnique({
          readModel: duplicateReadModel,
          command: updateCommand,
          workspaceRoot: "/tmp/shared-root",
          excludeProjectId: ProjectId.makeUnsafe("project-dup-2"),
        }),
      ),
    ).rejects.toThrow("already used by project");

    // project-dup-1 updates its own workspaceRoot - should detect project-dup-2 as a conflict
    await expect(
      Effect.runPromise(
        requireWorkspaceRootUnique({
          readModel: duplicateReadModel,
          command: updateCommand,
          workspaceRoot: "/tmp/shared-root",
          excludeProjectId: ProjectId.makeUnsafe("project-dup-1"),
        }),
      ),
    ).rejects.toThrow("already used by project");
  });
});
