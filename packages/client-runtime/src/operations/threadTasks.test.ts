import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationThreadShell,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  buildFollowUpThreadInput,
  buildStartProjectTaskInput,
  buildThreadTurnInterruptInput,
} from "./threadTasks.ts";

const CREATED_AT = "2026-08-10T10:00:00.000Z";
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex-default"),
  model: "gpt-5",
};
const ATTACHMENT: UploadChatAttachment = {
  type: "image",
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 12,
  dataUrl: "data:image/png;base64,YQ==",
};

const METADATA = {
  commandId: CommandId.make("command-1"),
  messageId: MessageId.make("message-1"),
  createdAt: CREATED_AT,
};

function thread(
  session: OrchestrationThreadShell["session"] = null,
): Pick<
  OrchestrationThreadShell,
  "id" | "title" | "modelSelection" | "runtimeMode" | "interactionMode" | "session"
> {
  return {
    id: ThreadId.make("thread-1"),
    title: "Existing task",
    modelSelection: MODEL_SELECTION,
    runtimeMode: "auto-accept-edits",
    interactionMode: "plan",
    session,
  };
}

describe("thread task builders", () => {
  it("builds an exact local atomic bootstrap with stable caller IDs", () => {
    const result = buildStartProjectTaskInput({
      ...METADATA,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
      title: "Fix the tests",
      titleSeed: "Fix the tests",
      text: "  Fix   the tests  ",
      attachments: [ATTACHMENT],
      modelSelection: MODEL_SELECTION,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspace: { mode: "local", branch: "main", worktreePath: "/workspace/project" },
    });

    expect(result).toEqual({
      commandId: "command-1",
      threadId: "thread-1",
      message: {
        messageId: "message-1",
        role: "user",
        text: "  Fix   the tests  ",
        attachments: [ATTACHMENT],
      },
      modelSelection: MODEL_SELECTION,
      titleSeed: "Fix the tests",
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: "project-1",
          title: "Fix the tests",
          modelSelection: MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: "/workspace/project",
          createdAt: CREATED_AT,
        },
      },
      createdAt: CREATED_AT,
    });
    const guaranteedModelSelection: ModelSelection = result.modelSelection;
    const guaranteedTitleSeed: string = result.titleSeed;
    expect(guaranteedModelSelection).toBe(MODEL_SELECTION);
    expect(guaranteedTitleSeed).toBe("Fix the tests");
    expect(result.message.attachments[0]).not.toBe(ATTACHMENT);
  });

  it("builds a safe worktree bootstrap without nullable base branches", () => {
    const result = buildStartProjectTaskInput({
      ...METADATA,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
      title: "Implement voice controls",
      titleSeed: "Implement voice controls",
      text: "Implement voice controls",
      attachments: [],
      modelSelection: MODEL_SELECTION,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspace: {
        mode: "worktree",
        projectCwd: "/workspace/project",
        baseBranch: "main",
        worktreeBranch: "t3/voice-controls",
        startFromOrigin: true,
      },
    });

    expect(result.bootstrap).toEqual({
      createThread: {
        projectId: "project-1",
        title: "Implement voice controls",
        modelSelection: MODEL_SELECTION,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: null,
        createdAt: CREATED_AT,
      },
      prepareWorktree: {
        projectCwd: "/workspace/project",
        baseBranch: "main",
        branch: "t3/voice-controls",
        startFromOrigin: true,
      },
      runSetupScript: true,
    });
    const requiredProjectCwd: string = result.bootstrap.prepareWorktree.projectCwd;
    const requiredSetupScript: true = result.bootstrap.runSetupScript;
    expect(requiredProjectCwd).toBe("/workspace/project");
    expect(requiredSetupScript).toBe(true);
  });

  it("preserves caller-owned title and titleSeed policy", () => {
    const result = buildStartProjectTaskInput({
      ...METADATA,
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
      title: "Client title",
      titleSeed: "Image: screenshot.png",
      text: "",
      attachments: [ATTACHMENT],
      modelSelection: MODEL_SELECTION,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspace: { mode: "local", branch: "main", worktreePath: "/workspace/project" },
    });

    expect(result.bootstrap.createThread.title).toBe("Client title");
    expect(result.titleSeed).toBe("Image: screenshot.png");
  });

  it("inherits existing thread settings for follow-ups and never bootstraps", () => {
    const result = buildFollowUpThreadInput({
      ...METADATA,
      thread: thread(),
      text: "Please continue",
      attachments: [ATTACHMENT],
    });

    expect(result).toMatchObject({
      commandId: "command-1",
      threadId: "thread-1",
      modelSelection: MODEL_SELECTION,
      titleSeed: "Existing task",
      runtimeMode: "auto-accept-edits",
      interactionMode: "plan",
      createdAt: CREATED_AT,
    });
    expect(result.bootstrap).toBeUndefined();
    const guaranteedModelSelection: ModelSelection = result.modelSelection;
    const guaranteedTitleSeed: string = result.titleSeed;
    expect(guaranteedModelSelection).toBe(MODEL_SELECTION);
    expect(guaranteedTitleSeed).toBe("Existing task");
    expect(result.message.messageId).toBe("message-1");
  });

  it("binds interrupts to an active turn and preserves caller metadata", () => {
    const runningSession = {
      threadId: ThreadId.make("thread-1"),
      status: "running" as const,
      providerName: "Codex",
      runtimeMode: "full-access" as const,
      activeTurnId: TurnId.make("turn-1"),
      lastError: null,
      updatedAt: CREATED_AT,
    };

    expect(
      buildThreadTurnInterruptInput({
        commandId: METADATA.commandId,
        createdAt: CREATED_AT,
        thread: thread(runningSession),
      }),
    ).toEqual({
      commandId: "command-1",
      threadId: "thread-1",
      turnId: "turn-1",
      createdAt: CREATED_AT,
    });
    expect(
      buildThreadTurnInterruptInput({
        commandId: METADATA.commandId,
        createdAt: CREATED_AT,
        thread: thread(),
      }),
    ).toEqual({
      commandId: "command-1",
      threadId: "thread-1",
      createdAt: CREATED_AT,
    });
  });
});
