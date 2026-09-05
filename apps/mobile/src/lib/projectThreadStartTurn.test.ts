import {
  EnvironmentId,
  ClientOrchestrationCommand,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { createComposerRecall, recallComposerText } from "@t3tools/shared/composerRecall";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectThreadStartTurnInput,
  deriveThreadTitleFromPrompt,
} from "./projectThreadStartTurn";

const decodeClientCommand = Schema.decodeUnknownSync(ClientOrchestrationCommand);

describe("project thread title", () => {
  it("round trips a project send through the wire without changing provider text", () => {
    const raw = "  Ultrathink:\nLiteral mobile example 😀\n";
    const spec = {
      projectId: ProjectId.make("project"),
      projectCwd: "/workspace",
      threadId: "thread",
      commandId: "command",
      messageId: "message",
      createdAt: "2026-09-05T00:00:00Z",
      text: raw.trim(),
      uploadedAttachments: [],
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceMode: "local",
      branch: null,
      worktreePath: null,
      startFromOrigin: false,
      worktreeBranchName: "unused",
    } as const;
    const input = buildProjectThreadStartTurnInput({
      ...spec,
      composerRecall: createComposerRecall(raw),
    });
    const command = decodeClientCommand(
      JSON.parse(JSON.stringify({ type: "thread.turn.start", ...input })),
    );
    expect(command.type).toBe("thread.turn.start");
    if (command.type !== "thread.turn.start") throw new Error("Unexpected command");
    expect(command.message.text).toBe(raw.trim());
    expect(recallComposerText(command.message)).toBe(raw);
    const legacy = buildProjectThreadStartTurnInput(spec);
    expect(legacy.message).toEqual({
      messageId: "message",
      role: "user",
      text: raw.trim(),
      attachments: [],
    });
    expect(input.titleSeed).toBe(legacy.titleSeed);
    expect(input.bootstrap).toEqual(legacy.bootstrap);
  });
  it("keeps ordinary titles and the empty-prompt fallback", () => {
    expect(deriveThreadTitleFromPrompt("  Fix\n the parser  ")).toBe("Fix the parser");
    expect(deriveThreadTitleFromPrompt(" \n ")).toBe("New thread");
  });

  it.each([
    {
      comment: undefined,
      title: "Keep `cache[key]` & <parser> shared. Retry!",
    },
    {
      comment: 'Why "shared"?',
      title: 'Keep `cache[key]` & <parser> shared. Retry! Comment: Why "shared"?',
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
