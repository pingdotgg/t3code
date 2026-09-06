import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  pendingThreadCreationMessage,
  pendingThreadCreationShell,
} from "./pending-thread-creation";
import type { QueuedThreadMessage } from "./thread-outbox-model";

const creation: QueuedThreadMessage = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  messageId: MessageId.make("message-1"),
  commandId: CommandId.make("command-1"),
  text: "Fix the flaky login test",
  attachments: [
    {
      id: "draft-image",
      type: "image",
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 10,
      previewUri: "data:image/png;base64,AAAA",
    },
  ],
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
  runtimeMode: "full-access",
  creation: {
    projectId: ProjectId.make("project-1"),
    workspaceMode: "worktree",
    branch: "main",
    worktreePath: null,
  },
  createdAt: "2026-08-24T12:00:00.000Z",
};

describe("pendingThreadCreationShell", () => {
  it("shapes a queued creation as the thread shell the screen renders before creation", () => {
    expect(pendingThreadCreationShell(creation)).toMatchObject({
      environmentId: creation.environmentId,
      id: creation.threadId,
      projectId: creation.creation!.projectId,
      title: "Fix the flaky login test",
      modelSelection: creation.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      latestTurn: null,
      session: null,
      latestUserMessageAt: creation.createdAt,
    });
  });

  it("keeps a local task's explicit worktree path", () => {
    expect(
      pendingThreadCreationShell({
        ...creation,
        creation: {
          ...creation.creation!,
          workspaceMode: "local",
          worktreePath: "/repo/.worktrees/feature",
        },
      })?.worktreePath,
    ).toBe("/repo/.worktrees/feature");
  });

  it("returns null for a follow-up message or a creation without a model", () => {
    expect(pendingThreadCreationShell({ ...creation, creation: undefined })).toBeNull();
    expect(pendingThreadCreationShell({ ...creation, modelSelection: undefined })).toBeNull();
  });
});

describe("pendingThreadCreationMessage", () => {
  it("renders the queued prompt as the first user message with its attachments named", () => {
    expect(pendingThreadCreationMessage(creation)).toEqual({
      id: creation.messageId,
      role: "user",
      text: creation.text,
      attachments: [
        {
          type: "image",
          id: "draft-image",
          name: "screen.png",
          mimeType: "image/png",
          sizeBytes: 10,
        },
      ],
      turnId: null,
      streaming: false,
      createdAt: creation.createdAt,
      updatedAt: creation.createdAt,
    });
  });
});
