import { describe, expect, it } from "vite-plus/test";

import { shouldShowParentThinking, type ParentThinkingSignals } from "./parentThinking.ts";

const active: ParentThinkingSignals = {
  sessionStatus: "running",
  latestTurnState: "running",
};

describe("shouldShowParentThinking", () => {
  it("shows while the parent turn is running with no other visible activity", () => {
    expect(shouldShowParentThinking(active)).toBe(true);
    expect(
      shouldShowParentThinking({
        sessionStatus: "starting",
        latestTurnState: null,
      }),
    ).toBe(true);
    expect(
      shouldShowParentThinking({
        sessionStatus: null,
        latestTurnState: "running",
      }),
    ).toBe(true);
  });

  it("hides when streamed assistant text or a streaming message is active", () => {
    expect(
      shouldShowParentThinking({
        ...active,
        hasStreamingAssistantText: true,
      }),
    ).toBe(false);
    expect(
      shouldShowParentThinking({
        ...active,
        hasActiveStreamingAssistant: true,
      }),
    ).toBe(false);
  });

  it("hides during tool execution", () => {
    expect(
      shouldShowParentThinking({
        ...active,
        hasActiveToolActivity: true,
      }),
    ).toBe(false);
  });

  it("hides during waiting, compaction-as-waiting, approvals, and stalls", () => {
    expect(
      shouldShowParentThinking({
        ...active,
        sessionStatus: "waiting",
      }),
    ).toBe(false);
    expect(
      shouldShowParentThinking({
        ...active,
        hasPendingApproval: true,
      }),
    ).toBe(false);
    expect(
      shouldShowParentThinking({
        ...active,
        hasPendingUserInput: true,
      }),
    ).toBe(false);
    expect(
      shouldShowParentThinking({
        ...active,
        isStalled: true,
      }),
    ).toBe(false);
  });

  it("hides on completion, cancellation, and failure", () => {
    expect(
      shouldShowParentThinking({
        sessionStatus: "idle",
        latestTurnState: "completed",
      }),
    ).toBe(false);
    expect(
      shouldShowParentThinking({
        sessionStatus: "interrupted",
        latestTurnState: "interrupted",
      }),
    ).toBe(false);
    expect(
      shouldShowParentThinking({
        sessionStatus: "error",
        latestTurnState: "error",
      }),
    ).toBe(false);
    expect(
      shouldShowParentThinking({
        sessionStatus: "stopped",
        latestTurnState: "completed",
      }),
    ).toBe(false);
  });

  it("hides when visible reasoning text already narrates the work", () => {
    expect(
      shouldShowParentThinking({
        ...active,
        hasVisibleReasoningText: true,
      }),
    ).toBe(false);
  });

  it("stays off when the session is quiescent", () => {
    expect(
      shouldShowParentThinking({
        sessionStatus: "ready",
        latestTurnState: null,
      }),
    ).toBe(false);
    expect(
      shouldShowParentThinking({
        sessionStatus: null,
        latestTurnState: null,
      }),
    ).toBe(false);
  });
});
