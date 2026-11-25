import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@lathe/contracts";
import {
  buildContinuePrompt,
  buildThreadContextRecord,
} from "@lathe/shared/threadContextReference";
import { describe, expect, it } from "vite-plus/test";

import { serializeComposerMessageForServer } from "./composerContext";

import {
  buildProjectThreadStartTurnInput,
  deriveThreadTitleFromPrompt,
  type ProjectThreadStartTurnSpec,
} from "./projectThreadStartTurn";

describe("project thread title", () => {
  it.each([
    {
      type: "image" as const,
      name: "photo.png",
      mimeType: "image/png",
      text: "![photo.png](lathe-context://v1/image/photo)",
      title: "Attached image",
    },
    {
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      text: "",
      title: "File: report.pdf",
    },
    {
      type: "file" as const,
      name: "report.pdf",
      mimeType: "application/pdf",
      text: "[report.pdf](lathe-context://v1/file/report)",
      title: "report.pdf",
    },
  ])("titles a $type-only message without changing its data", ({ text, title, ...attachment }) => {
    const uploadedAttachments = [{ ...attachment, id: "prepared-attachment", sizeBytes: 3 }];
    const wire = serializeComposerMessageForServer(text, undefined);
    const spec = {
      projectId: ProjectId.make("project"),
      projectCwd: "/workspace",
      threadId: "image-thread",
      commandId: "image-command",
      messageId: "image-message",
      createdAt: "2026-09-04T00:00:00Z",
      ...wire,
      titleText: text,
      uploadedAttachments,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceMode: "local",
      branch: null,
      worktreePath: null,
      startFromOrigin: false,
      worktreeBranchName: "unused",
    } satisfies ProjectThreadStartTurnSpec;
    const input = buildProjectThreadStartTurnInput(spec);

    expect(input.titleSeed).toBe(title);
    expect(input.bootstrap.createThread.title).toBe(input.titleSeed);
    expect(input.message.attachments).toEqual(uploadedAttachments);
    expect(input.message.text).toBe(wire.text);
    const relaunched = buildProjectThreadStartTurnInput({
      ...spec,
      threadId: "local-relaunch",
      text: input.message.text,
      titleText: input.bootstrap.createThread.title,
    });
    expect(relaunched.titleSeed).toBe(title);
    expect(relaunched.message.text).toBe(wire.text);
    expect(relaunched.message.attachments).toEqual(uploadedAttachments);
  });

  it("starts a worktree of a plain project folder from each repository's default branch", () => {
    const input = buildProjectThreadStartTurnInput({
      projectId: ProjectId.make("project"),
      projectCwd: "/workspace",
      threadId: "thread",
      commandId: "command",
      messageId: "message",
      createdAt: "2026-09-04T00:00:00Z",
      text: "Fix the build",
      uploadedAttachments: [],
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceMode: "worktree",
      branch: null,
      worktreePath: null,
      startFromOrigin: false,
      worktreeRepositories: ["/workspace/api"],
      worktreeBranchName: "t3/new",
    });

    expect(input.bootstrap.prepareWorktree).toEqual({
      projectCwd: "/workspace",
      baseBranch: "HEAD",
      branch: "t3/new",
      repositories: [{ path: "/workspace/api" }],
    });
  });

  it("shortens a long prompt without splitting an emoji", () => {
    expect(deriveThreadTitleFromPrompt(`${"a".repeat(68)}😀 and the rest of the prompt`)).toBe(
      `${"a".repeat(68)}...`,
    );
  });
});

describe("continuing another thread", () => {
  const source = buildThreadContextRecord({
    environmentId: EnvironmentId.make("source-environment"),
    id: ThreadId.make("thread-earlier"),
    title: "Earlier investigation",
  });
  const spec = {
    projectId: ProjectId.make("project"),
    projectCwd: "/workspace",
    threadId: "new-thread",
    commandId: "command",
    messageId: "message",
    createdAt: "2026-09-30T00:00:00Z",
    text: buildContinuePrompt(source),
    uploadedAttachments: [],
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    workspaceMode: "local" as const,
    branch: null,
    worktreePath: null,
    startFromOrigin: false,
    worktreeBranchName: "unused",
    continuedFromThreadId: source.threadId,
  };

  it("records the source and titles the thread after it while the chip is present", () => {
    const input = buildProjectThreadStartTurnInput({
      ...spec,
      context: { version: 1, records: [source] },
    });

    expect(input.bootstrap.createThread.continuedFromThreadId).toBe(source.threadId);
    expect(input.titleSeed).toBe("Continue: Earlier investigation");
    expect(input.bootstrap.createThread.title).toBe(input.titleSeed);
  });

  it("drops the link and the source title once the chip was removed", () => {
    const input = buildProjectThreadStartTurnInput({ ...spec, text: "Start over" });

    expect(input.bootstrap.createThread).not.toHaveProperty("continuedFromThreadId");
    expect(input.titleSeed).toBe("Start over");
  });
});
