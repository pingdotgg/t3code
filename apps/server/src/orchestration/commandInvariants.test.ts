import { describe, expect, it } from "vitest";
import type { OrchestrationCommand, OrchestrationReadModel } from "@t3tools/contracts";
import { Effect } from "effect";

import {
  findThreadById,
  listThreadsByProjectId,
  requireNonNegativeInteger,
  requireThread,
  requireThreadAbsent,
} from "./commandInvariants.ts";

const now = new Date().toISOString();

const readModel: OrchestrationReadModel = {
  snapshotSequence: 2,
  updatedAt: now,
  projects: [
    {
      id: "project-a",
      title: "Project A",
      workspaceRoot: "/tmp/project-a",
      defaultModel: "gpt-5-codex",
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: "project-b",
      title: "Project B",
      workspaceRoot: "/tmp/project-b",
      defaultModel: "gpt-5-codex",
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  threads: [
    {
      id: "thread-1",
      projectId: "project-a",
      title: "Thread A",
      model: "gpt-5-codex",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      latestTurnId: null,
      messages: [],
      session: null,
      activities: [],
      checkpoints: [],
    },
    {
      id: "thread-2",
      projectId: "project-b",
      title: "Thread B",
      model: "gpt-5-codex",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      latestTurnId: null,
      messages: [],
      session: null,
      activities: [],
      checkpoints: [],
    },
  ],
};

const messageSendCommand: OrchestrationCommand = {
  type: "thread.turn.start",
  commandId: "cmd-1",
  threadId: "thread-1",
  message: {
    messageId: "msg-1",
    role: "user",
    text: "hello",
    attachments: [],
  },
  createdAt: now,
};

describe("commandInvariants", () => {
  it("finds threads by id and project", () => {
    expect(findThreadById(readModel, "thread-1")?.projectId).toBe("project-a");
    expect(findThreadById(readModel, "missing")).toBeUndefined();
    expect(listThreadsByProjectId(readModel, "project-b").map((thread) => thread.id)).toEqual([
      "thread-2",
    ]);
  });

  it("requires existing thread", async () => {
    const thread = await Effect.runPromise(
      requireThread({
        readModel,
        command: messageSendCommand,
        threadId: "thread-1",
      }),
    );
    expect(thread.id).toBe("thread-1");

    await expect(
      Effect.runPromise(
        requireThread({
          readModel,
          command: messageSendCommand,
          threadId: "missing",
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
          commandId: "cmd-2",
          threadId: "thread-3",
          projectId: "project-a",
          title: "new",
          model: "gpt-5-codex",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        threadId: "thread-3",
      }),
    );

    await expect(
      Effect.runPromise(
        requireThreadAbsent({
          readModel,
          command: {
            type: "thread.create",
            commandId: "cmd-3",
            threadId: "thread-1",
            projectId: "project-a",
            title: "dup",
            model: "gpt-5-codex",
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
          threadId: "thread-1",
        }),
      ),
    ).rejects.toThrow("already exists");
  });

  it("requires non-negative integers", async () => {
    await Effect.runPromise(
      requireNonNegativeInteger({
        commandType: "thread.revert",
        field: "turnCount",
        value: 0,
      }),
    );

    await expect(
      Effect.runPromise(
        requireNonNegativeInteger({
          commandType: "thread.revert",
          field: "turnCount",
          value: -1,
        }),
      ),
    ).rejects.toThrow("greater than or equal to 0");
  });
});
