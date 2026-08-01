import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type PreviewAnnotationPayload,
} from "@t3tools/contracts";

vi.mock("./uuid", () => ({
  uuidv4: () => "unused",
}));

import { buildProjectThreadStartTurnInput } from "./projectThreadStartTurn";
import { validateProjectThreadCreation } from "../features/threads/projectThreadCreationValidation";

const ANNOTATION: PreviewAnnotationPayload = {
  id: "annotation-1",
  pageUrl: "",
  pageTitle: "Attached screenshot",
  comment: "Make the primary action more prominent",
  elements: [],
  regions: [],
  strokes: [],
  styleChanges: [],
  screenshot: null,
  createdAt: "2026-07-30T10:00:00.000Z",
  callouts: [
    {
      id: "callout-1",
      number: 1,
      comment: "Make the primary action more prominent",
      anchor: { kind: "point", point: { x: 0.5, y: 0.5 } },
    },
  ],
};

const MARKED_ATTACHMENT = {
  id: "attachment-1",
  type: "image" as const,
  name: "checkout-markup.png",
  mimeType: "image/png",
  sizeBytes: 16,
  dataUrl: "data:image/png;base64,YW5ub3RhdGVk",
  previewUri: "data:image/png;base64,YW5ub3RhdGVk",
  markup: {
    annotation: ANNOTATION,
    original: {
      name: "checkout.png",
      mimeType: "image/png",
      sizeBytes: 8,
      dataUrl: "data:image/png;base64,b3JpZ2luYWw=",
      previewUri: "file:///tmp/checkout.png",
    },
  },
};

describe("buildProjectThreadStartTurnInput", () => {
  it("delivers attachment annotations without including them in the thread title", () => {
    const input = buildProjectThreadStartTurnInput({
      projectId: ProjectId.make("project-1"),
      projectCwd: "/repo",
      threadId: "thread-1",
      commandId: "command-1",
      messageId: "message-1",
      createdAt: "2026-07-30T10:00:00.000Z",
      text: "Fix the checkout screen",
      attachments: [MARKED_ATTACHMENT],
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      workspaceMode: "local",
      branch: null,
      worktreePath: null,
      startFromOrigin: false,
      worktreeBranchName: "unused",
    });

    expect(input.titleSeed).toBe("Fix the checkout screen");
    expect(input.bootstrap.createThread.title).toBe("Fix the checkout screen");
    expect(input.message.text).toContain("Fix the checkout screen");
    expect(input.message.text).toContain("<preview_annotation>");
    expect(input.message.text).toContain("Make the primary action more prominent");
    expect(input.message.attachments).toEqual([
      {
        type: "image",
        name: "checkout-markup.png",
        mimeType: "image/png",
        sizeBytes: 16,
        dataUrl: "data:image/png;base64,YW5ub3RhdGVk",
      },
    ]);
  });

  it("uses an annotation comment as the title and instruction when raw text is empty", () => {
    const input = buildProjectThreadStartTurnInput({
      projectId: ProjectId.make("project-1"),
      projectCwd: "/repo",
      threadId: "thread-1",
      commandId: "command-1",
      messageId: "message-1",
      createdAt: "2026-07-30T10:00:00.000Z",
      text: "",
      attachments: [MARKED_ATTACHMENT],
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      workspaceMode: "local",
      branch: null,
      worktreePath: null,
      startFromOrigin: false,
      worktreeBranchName: "unused",
    });

    expect(input.titleSeed).toBe("Make the primary action more prominent");
    expect(input.bootstrap.createThread.title).toBe("Make the primary action more prominent");
    expect(input.message.text).toContain("<preview_annotation>");
    expect(input.message.text).toContain("Make the primary action more prominent");
  });
});

describe("validateProjectThreadCreation", () => {
  const base = {
    environmentId: EnvironmentId.make("environment-1"),
    projectId: ProjectId.make("project-1"),
    environmentMode: "local" as const,
    branch: null,
    initialMessageText: "",
  };

  it("accepts an attachment-only task but still rejects a completely empty task", () => {
    expect(validateProjectThreadCreation({ ...base, initialAttachmentCount: 1 })).toBeNull();
    expect(validateProjectThreadCreation({ ...base, initialAttachmentCount: 0 })?._tag).toBe(
      "ProjectThreadTaskRequiredError",
    );
  });
});
