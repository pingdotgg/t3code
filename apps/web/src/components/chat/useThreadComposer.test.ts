import { MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ChatMessage } from "../../types";
import { deriveComposerSendState } from "../ChatView.logic";

import {
  boardComposerDraftCanBeRestored,
  mergeBoardTimelineMessages,
  parseBoardCodexFeedbackCommand,
  parseBoardStandaloneComposerSlashCommand,
  removeBoardAttachmentPreviewHandoff,
  resolveBoardAttachmentUploadCapabilities,
  resolveBoardExpiredTerminalContextToastCopy,
  resolveBoardLocalCheckoutStatusGuard,
  resolveBoardTimelineWorkingState,
  resolveBoardComposerModes,
} from "./useThreadComposer";

describe("board thread composer", () => {
  it("only restores a failed board send when the user has not typed into that card again", () => {
    expect(boardComposerDraftCanBeRestored({ prompt: "", images: [] })).toBe(true);
    expect(boardComposerDraftCanBeRestored({ prompt: "new work", images: [] })).toBe(false);
    expect(
      boardComposerDraftCanBeRestored({
        prompt: "",
        images: [{} as never],
      }),
    ).toBe(false);
  });

  it("recognizes feedback only for a plain Codex board draft", () => {
    expect(
      parseBoardCodexFeedbackCommand({
        provider: "codex",
        prompt: "/feedback The agent stopped early.",
        hasAttachments: false,
        hasContexts: false,
      }),
    ).toEqual({ reason: "The agent stopped early." });
    expect(
      parseBoardCodexFeedbackCommand({
        provider: "claude",
        prompt: "/feedback",
        hasAttachments: false,
        hasContexts: false,
      }),
    ).toBeNull();
    expect(
      parseBoardCodexFeedbackCommand({
        provider: "codex",
        prompt: "/feedback",
        hasAttachments: true,
        hasContexts: false,
      }),
    ).toBeNull();
  });

  it("treats expired terminal context as absent for feedback detection", () => {
    const sendState = deriveComposerSendState({
      prompt: "/feedback The agent stopped early.",
      imageCount: 0,
      terminalContexts: [
        {
          id: "expired-terminal-context",
          threadId: ThreadId.make("thread-1"),
          terminalId: "terminal-1",
          terminalLabel: "Terminal 1",
          lineStart: 1,
          lineEnd: 1,
          text: "",
          createdAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    });

    expect(sendState.sendableTerminalContexts).toEqual([]);
    expect(
      parseBoardCodexFeedbackCommand({
        provider: "codex",
        prompt: sendState.trimmedPrompt,
        hasAttachments: false,
        hasContexts: sendState.sendableTerminalContexts.length > 0,
      }),
    ).toEqual({ reason: "The agent stopped early." });
  });

  it("recognizes standalone mode commands only for an empty enabled-plan draft", () => {
    expect(
      parseBoardStandaloneComposerSlashCommand({
        planModeEnabled: true,
        prompt: " /plan ",
        hasAttachments: false,
        hasContexts: false,
      }),
    ).toBe("plan");
    expect(
      parseBoardStandaloneComposerSlashCommand({
        planModeEnabled: true,
        prompt: "/default",
        hasAttachments: false,
        hasContexts: false,
      }),
    ).toBe("default");
    expect(
      parseBoardStandaloneComposerSlashCommand({
        planModeEnabled: false,
        prompt: "/plan",
        hasAttachments: false,
        hasContexts: false,
      }),
    ).toBeNull();
    expect(
      parseBoardStandaloneComposerSlashCommand({
        planModeEnabled: true,
        prompt: "/default",
        hasAttachments: false,
        hasContexts: true,
      }),
    ).toBeNull();
  });

  it("removes only the optimistic message that the server has projected", () => {
    const message = (id: string, text: string): ChatMessage => ({
      id: MessageId.make(id),
      role: "user",
      text,
      turnId: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      streaming: false,
    });
    const projected = message("projected", "server copy");
    const stillPending = message("pending", "another pending send");

    expect(
      mergeBoardTimelineMessages(
        [projected],
        [message("projected", "optimistic copy"), stillPending],
        {},
      ),
    ).toEqual([projected, stillPending]);
  });

  it("removes a preview handoff while returning its blob URLs for cleanup", () => {
    const handoffs = {
      projected: ["blob:preview-1", "blob:preview-2"],
      pending: ["blob:preview-3"],
    } as const;

    expect(removeBoardAttachmentPreviewHandoff(handoffs, "projected")).toEqual({
      next: { pending: ["blob:preview-3"] },
      previewUrls: ["blob:preview-1", "blob:preview-2"],
    });
    expect(removeBoardAttachmentPreviewHandoff(handoffs, "missing")).toBeNull();
  });

  it("warns when expired terminal context is omitted or is the only content", () => {
    expect(resolveBoardExpiredTerminalContextToastCopy(1, false)).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
    expect(resolveBoardExpiredTerminalContextToastCopy(2, true)).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
    expect(resolveBoardExpiredTerminalContextToastCopy(0, true)).toBeNull();
  });

  it("uses the server attachment-upload capability when it is known", () => {
    expect(resolveBoardAttachmentUploadCapabilities(undefined)).toEqual({
      attachmentUploadsCapabilityKnown: false,
      supportsAttachmentUploads: false,
    });
    expect(resolveBoardAttachmentUploadCapabilities({ environment: { capabilities: {} } })).toEqual(
      {
        attachmentUploadsCapabilityKnown: true,
        supportsAttachmentUploads: false,
      },
    );
    expect(
      resolveBoardAttachmentUploadCapabilities({
        environment: { capabilities: { attachmentUploads: true } },
      }),
    ).toEqual({
      attachmentUploadsCapabilityKnown: true,
      supportsAttachmentUploads: true,
    });
  });

  it("waits for initial local status but lets failed queries skip reconciliation", () => {
    const base = {
      activeWorktreePath: null,
      activeBranch: "main",
      gitCwd: "/repo",
    } as const;
    expect(
      resolveBoardLocalCheckoutStatusGuard({
        ...base,
        statusData: null,
        statusError: null,
      }),
    ).toBe("pending");
    expect(
      resolveBoardLocalCheckoutStatusGuard({
        ...base,
        statusData: null,
        statusError: "status failed",
      }),
    ).toBeNull();
    expect(
      resolveBoardLocalCheckoutStatusGuard({
        ...base,
        statusData: { refName: "main" },
        statusError: null,
      }),
    ).toBeNull();
    expect(
      resolveBoardLocalCheckoutStatusGuard({
        ...base,
        activeWorktreePath: "/repo/.worktrees/feature",
        statusData: null,
        statusError: null,
      }),
    ).toBeNull();
  });

  it("falls back to build mode when a retained plan mode is disabled", () => {
    expect(
      resolveBoardComposerModes({
        planModeEnabled: false,
        draftRuntimeMode: null,
        draftInteractionMode: null,
        summaryRuntimeMode: "full-access",
        summaryInteractionMode: "plan",
      }),
    ).toEqual({ runtimeMode: "full-access", interactionMode: "default" });
  });

  it("uses per-thread draft modes ahead of stale thread summary modes", () => {
    expect(
      resolveBoardComposerModes({
        planModeEnabled: true,
        draftRuntimeMode: "approval-required",
        draftInteractionMode: "plan",
        summaryRuntimeMode: "full-access",
        summaryInteractionMode: "default",
      }),
    ).toEqual({ runtimeMode: "approval-required", interactionMode: "plan" });
  });

  it("shows local send work until the server timeline takes over", () => {
    const localSendStartedAt = "2026-09-01T12:00:00.000Z";

    expect(
      resolveBoardTimelineWorkingState({
        serverIsWorking: false,
        serverActiveTurnStartedAt: null,
        isLocalSendBusy: true,
        localSendStartedAt,
      }),
    ).toEqual({ isWorking: true, activeTurnStartedAt: localSendStartedAt });
    expect(
      resolveBoardTimelineWorkingState({
        serverIsWorking: false,
        serverActiveTurnStartedAt: "2026-09-01T11:00:00.000Z",
        isLocalSendBusy: true,
        localSendStartedAt,
      }),
    ).toEqual({ isWorking: true, activeTurnStartedAt: localSendStartedAt });
    expect(
      resolveBoardTimelineWorkingState({
        serverIsWorking: true,
        serverActiveTurnStartedAt: "2026-09-01T12:00:03.000Z",
        isLocalSendBusy: true,
        localSendStartedAt,
      }),
    ).toEqual({ isWorking: true, activeTurnStartedAt: "2026-09-01T12:00:03.000Z" });
    expect(
      resolveBoardTimelineWorkingState({
        serverIsWorking: false,
        serverActiveTurnStartedAt: null,
        isLocalSendBusy: false,
        localSendStartedAt: null,
      }),
    ).toEqual({ isWorking: false, activeTurnStartedAt: null });
  });
});
