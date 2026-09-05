import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectThreadStartTurnInput,
  deriveThreadTitleFromPrompt,
} from "./projectThreadStartTurn";

describe("project thread title", () => {
  it("keeps ordinary titles and the empty-prompt fallback", () => {
    expect(deriveThreadTitleFromPrompt("  Fix\n the parser  ")).toBe("Fix the parser");
    expect(deriveThreadTitleFromPrompt(" \n ")).toBe("New thread");
  });

  it("derives attachment-only titles from prepared image metadata", () => {
    const uploadedAttachments = [
      {
        type: "image" as const,
        id: "prepared-photo",
        name: "photo.png",
        mimeType: "image/png",
        sizeBytes: 3,
      },
    ];
    const input = buildProjectThreadStartTurnInput({
      projectId: ProjectId.make("project"),
      projectCwd: "/workspace",
      threadId: "image-thread",
      commandId: "image-command",
      messageId: "image-message",
      createdAt: "2026-09-04T00:00:00Z",
      text: "",
      uploadedAttachments,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceMode: "local",
      branch: null,
      worktreePath: null,
      startFromOrigin: false,
      worktreeBranchName: "unused",
    });

    expect(input.titleSeed).toBe("Image: photo.png");
    expect(input.bootstrap.createThread.title).toBe(input.titleSeed);
    expect(input.message.attachments).toEqual(uploadedAttachments);
  });

  it.each([
    {
      comment: undefined,
      title: "Keep `cache[key]` & <parser> shared. Retry!",
    },
    {
      comment: 'Why "shared"?',
      title: "Keep `cache[key]` & <parser> shared. Retry! Commen...",
    },
  ])("uses readable titles and intact links with comment $comment", ({ comment, title }) => {
    const quoteText = "Keep `cache[key]` & <parser> shared.\n  Retry!";
    const text = serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("source-environment"),
      threadId: ThreadId.make("source-thread"),
      messageId: MessageId.make("source-message"),
      text: quoteText,
      ...(comment === undefined ? {} : { comment }),
      start: 0,
      end: quoteText.length,
      prefix: "",
      suffix: "",
    });
    const input = buildProjectThreadStartTurnInput({
      projectId: ProjectId.make("project"),
      projectCwd: "/workspace",
      threadId: "new-thread",
      commandId: "command",
      messageId: "message",
      createdAt: "2026-09-01T00:00:00Z",
      text,
      uploadedAttachments: [],
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceMode: "local",
      branch: null,
      worktreePath: null,
      startFromOrigin: false,
      worktreeBranchName: "unused",
    });

    expect(input.titleSeed).toBe(title);
    expect(input.bootstrap.createThread.title).toBe(input.titleSeed);
    expect(input.message.text).toBe(text);
  });
});
