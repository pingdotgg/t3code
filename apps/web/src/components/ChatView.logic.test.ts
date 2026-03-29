import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildExpiredTerminalContextToastCopy,
  buildQueuedFollowUpDraft,
  canAutoDispatchQueuedFollowUp,
  deriveComposerSendState,
  followUpBehaviorShortcutLabel,
  resolveFollowUpBehavior,
  shouldInvertFollowUpBehaviorFromKeyEvent,
} from "./ChatView.logic";

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.makeUnsafe("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.makeUnsafe("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats clear empty-state guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
  });

  it("formats omission guidance for sent messages", () => {
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("follow-up behavior helpers", () => {
  it("inverts the configured behavior when requested", () => {
    expect(resolveFollowUpBehavior("steer", false)).toBe("steer");
    expect(resolveFollowUpBehavior("steer", true)).toBe("queue");
    expect(resolveFollowUpBehavior("queue", true)).toBe("steer");
  });

  it("detects the opposite-submit keyboard shortcut across platforms", () => {
    expect(
      shouldInvertFollowUpBehaviorFromKeyEvent(
        {
          ctrlKey: true,
          metaKey: false,
          shiftKey: true,
          altKey: false,
        },
        "Win32",
      ),
    ).toBe(true);
    expect(
      shouldInvertFollowUpBehaviorFromKeyEvent(
        {
          ctrlKey: false,
          metaKey: true,
          shiftKey: true,
          altKey: false,
        },
        "MacIntel",
      ),
    ).toBe(true);
    expect(
      shouldInvertFollowUpBehaviorFromKeyEvent(
        {
          ctrlKey: false,
          metaKey: false,
          shiftKey: true,
          altKey: false,
        },
        "Win32",
      ),
    ).toBe(false);
    expect(followUpBehaviorShortcutLabel("MacIntel")).toBe("Cmd+Shift+Enter");
    expect(followUpBehaviorShortcutLabel("Win32")).toBe("Ctrl+Shift+Enter");
  });

  it("builds a queued follow-up snapshot and auto-dispatch rules", () => {
    const snapshot = buildQueuedFollowUpDraft({
      prompt: "next step",
      attachments: [],
      terminalContexts: [
        {
          id: "ctx-1",
          threadId: ThreadId.makeUnsafe("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 1,
          lineEnd: 1,
          text: "hello",
          createdAt: "2026-03-27T12:00:00.000Z",
        },
      ],
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: "2026-03-27T12:00:00.000Z",
    });

    expect(snapshot.id).toBeTruthy();
    expect(snapshot.terminalContexts[0]?.text).toBe("hello");
    expect(
      canAutoDispatchQueuedFollowUp({
        phase: "ready",
        queuedFollowUpCount: 2,
        queuedHeadHasError: false,
        isConnecting: false,
        isSendBusy: false,
        isRevertingCheckpoint: false,
        hasThreadError: false,
        hasPendingApproval: false,
        hasPendingUserInput: false,
      }),
    ).toBe(true);
    expect(
      canAutoDispatchQueuedFollowUp({
        phase: "running",
        queuedFollowUpCount: 2,
        queuedHeadHasError: false,
        isConnecting: false,
        isSendBusy: false,
        isRevertingCheckpoint: false,
        hasThreadError: false,
        hasPendingApproval: false,
        hasPendingUserInput: false,
      }),
    ).toBe(false);
    expect(
      canAutoDispatchQueuedFollowUp({
        phase: "ready",
        queuedFollowUpCount: 1,
        queuedHeadHasError: true,
        isConnecting: false,
        isSendBusy: false,
        isRevertingCheckpoint: false,
        hasThreadError: false,
        hasPendingApproval: false,
        hasPendingUserInput: false,
      }),
    ).toBe(false);
  });
});
