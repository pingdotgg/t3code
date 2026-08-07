import type { MessageId, ModelSelection, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadLaunchInput, type ThreadLaunchSpec } from "./threadLaunch";

const MODEL_SELECTION = {
  instanceId: "claudeAgent",
  model: "claude-opus-5",
} as unknown as ModelSelection;

const IDENTITY = {
  threadId: "thread-1" as ThreadId,
  messageId: "message-1" as MessageId,
  createdAt: "2026-08-07T10:00:00.000Z",
};

const BASE_SPEC: ThreadLaunchSpec = {
  projectId: "project-1" as ProjectId,
  title: "/rooom:ship FE-1",
  prompt: "/rooom:ship FE-1",
  modelSelection: MODEL_SELECTION,
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: "main",
  worktree: null,
};

describe("buildThreadLaunchInput", () => {
  it("creates the thread with the shared settings and no attachments", () => {
    const input = buildThreadLaunchInput(BASE_SPEC, IDENTITY);

    expect(input.threadId).toBe("thread-1");
    expect(input.message).toEqual({
      messageId: "message-1",
      role: "user",
      text: "/rooom:ship FE-1",
      attachments: [],
    });
    expect(input.bootstrap?.createThread).toEqual({
      projectId: "project-1",
      title: "/rooom:ship FE-1",
      modelSelection: MODEL_SELECTION,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      createdAt: IDENTITY.createdAt,
    });
  });

  it("omits worktree preparation when the thread stays on the checkout", () => {
    const input = buildThreadLaunchInput(BASE_SPEC, IDENTITY);

    expect(input.bootstrap?.prepareWorktree).toBeUndefined();
    expect(input.bootstrap?.runSetupScript).toBeUndefined();
  });

  it("prepares a worktree and runs the setup script when one is requested", () => {
    const input = buildThreadLaunchInput(
      {
        ...BASE_SPEC,
        worktree: {
          projectCwd: "/repo",
          baseBranch: "main",
          branch: "t3/worktree/deadbeef",
          startFromOrigin: true,
        },
      },
      IDENTITY,
    );

    expect(input.bootstrap?.prepareWorktree).toEqual({
      projectCwd: "/repo",
      baseBranch: "main",
      branch: "t3/worktree/deadbeef",
      startFromOrigin: true,
    });
    expect(input.bootstrap?.runSetupScript).toBe(true);
  });

  it("leaves startFromOrigin off the payload when it is not requested", () => {
    const input = buildThreadLaunchInput(
      {
        ...BASE_SPEC,
        worktree: {
          projectCwd: "/repo",
          baseBranch: "main",
          branch: "t3/worktree/deadbeef",
          startFromOrigin: false,
        },
      },
      IDENTITY,
    );

    expect(input.bootstrap?.prepareWorktree).toEqual({
      projectCwd: "/repo",
      baseBranch: "main",
      branch: "t3/worktree/deadbeef",
    });
  });
});
