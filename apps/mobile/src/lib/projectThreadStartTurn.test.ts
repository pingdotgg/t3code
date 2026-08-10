import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildProjectThreadStartTurnInput } from "./projectThreadStartTurn";

vi.mock("expo-crypto", () => ({
  randomUUID: vi.fn(() => "00000000-0000-4000-8000-000000000000"),
  getRandomBytes: vi.fn(() => new Uint8Array()),
}));

const BASE_SPEC = {
  projectId: ProjectId.make("project-1"),
  projectCwd: "/workspace/project",
  threadId: "thread-1",
  commandId: "command-1",
  messageId: "message-1",
  createdAt: "2026-08-10T10:00:00.000Z",
  text: "Start a task",
  attachments: [],
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex-default"),
    model: "gpt-5",
  },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: "main",
  worktreePath: null,
  startFromOrigin: false,
  worktreeBranchName: "t3/task",
};

describe("buildProjectThreadStartTurnInput", () => {
  it("preserves the exact legacy local payload and strips draft-only image fields", () => {
    const result = buildProjectThreadStartTurnInput({
      ...BASE_SPEC,
      workspaceMode: "local",
      worktreePath: "/workspace/project",
      attachments: [
        {
          id: "draft-image-1",
          previewUri: "file:///draft-preview.png",
          type: "image",
          name: "proof.png",
          mimeType: "image/png",
          sizeBytes: 4,
          dataUrl: "data:image/png;base64,cHJvb2Y=",
        },
      ],
    });

    expect(result).toEqual({
      commandId: "command-1",
      threadId: "thread-1",
      message: {
        messageId: "message-1",
        role: "user",
        text: "Start a task",
        attachments: [
          {
            type: "image",
            name: "proof.png",
            mimeType: "image/png",
            sizeBytes: 4,
            dataUrl: "data:image/png;base64,cHJvb2Y=",
          },
        ],
      },
      modelSelection: BASE_SPEC.modelSelection,
      titleSeed: "Start a task",
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: "project-1",
          title: "Start a task",
          modelSelection: BASE_SPEC.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: "/workspace/project",
          createdAt: "2026-08-10T10:00:00.000Z",
        },
      },
      createdAt: "2026-08-10T10:00:00.000Z",
    });
  });

  it("adapts worktree drafts without a non-null assertion", () => {
    const result = buildProjectThreadStartTurnInput({
      ...BASE_SPEC,
      workspaceMode: "worktree",
      startFromOrigin: true,
    });

    expect(result.bootstrap?.prepareWorktree).toEqual({
      projectCwd: "/workspace/project",
      baseBranch: "main",
      branch: "t3/task",
      startFromOrigin: true,
    });
  });

  it("rejects an invalid worktree draft before constructing a wire command", () => {
    expect(() =>
      buildProjectThreadStartTurnInput({
        ...BASE_SPEC,
        workspaceMode: "worktree",
        branch: null,
      }),
    ).toThrow("A base branch is required");
  });
});
