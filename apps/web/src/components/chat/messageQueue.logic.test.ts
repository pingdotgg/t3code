import { describe, expect, it } from "vite-plus/test";

import {
  canFlushQueuedMessage,
  formatQueuedMessagePreview,
  shouldQueueOutgoingMessage,
} from "./messageQueue.logic";

const idleComposer = {
  phase: "ready",
  isSendBusy: false,
  hasPendingApproval: false,
  hasPendingUserInput: false,
  queuedCount: 0,
} as const;

const flushableThread = {
  phase: "ready",
  hasActiveTurn: false,
  isSendBusy: false,
  isSendInFlight: false,
  hasPendingApproval: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
} as const;

describe("shouldQueueOutgoingMessage", () => {
  it("sends straight away while the agent is idle", () => {
    expect(shouldQueueOutgoingMessage(idleComposer)).toBe(false);
  });

  it("queues while the turn runs or the session is still connecting", () => {
    expect(shouldQueueOutgoingMessage({ ...idleComposer, phase: "running" })).toBe(true);
    expect(shouldQueueOutgoingMessage({ ...idleComposer, phase: "connecting" })).toBe(true);
  });

  it("queues while an approval or a question is open", () => {
    expect(shouldQueueOutgoingMessage({ ...idleComposer, hasPendingApproval: true })).toBe(true);
    expect(shouldQueueOutgoingMessage({ ...idleComposer, hasPendingUserInput: true })).toBe(true);
  });

  it("queues behind messages that are already waiting", () => {
    expect(shouldQueueOutgoingMessage({ ...idleComposer, queuedCount: 1 })).toBe(true);
  });

  it("sends to a disconnected thread instead of queueing", () => {
    expect(shouldQueueOutgoingMessage({ ...idleComposer, phase: "disconnected" })).toBe(false);
  });
});

describe("canFlushQueuedMessage", () => {
  it("flushes once the agent is done and waiting for a new instruction", () => {
    expect(canFlushQueuedMessage(flushableThread)).toBe(true);
  });

  it("waits while a turn is still active", () => {
    expect(canFlushQueuedMessage({ ...flushableThread, phase: "running" })).toBe(false);
    expect(canFlushQueuedMessage({ ...flushableThread, phase: "connecting" })).toBe(false);
    expect(canFlushQueuedMessage({ ...flushableThread, hasActiveTurn: true })).toBe(false);
  });

  // Regression: a steered turn is projected as a pending row without a turn
  // id, which clears the thread's latest turn. Reading idleness from the turn
  // instead of the session kept the queue closed for the rest of the thread.
  it("flushes after a steer left the thread without a latest turn", () => {
    expect(canFlushQueuedMessage({ ...flushableThread })).toBe(true);
  });

  it("waits for open questions rather than answering them with the next prompt", () => {
    expect(canFlushQueuedMessage({ ...flushableThread, hasPendingApproval: true })).toBe(false);
    expect(canFlushQueuedMessage({ ...flushableThread, hasPendingUserInput: true })).toBe(false);
    expect(canFlushQueuedMessage({ ...flushableThread, hasActionableProposedPlan: true })).toBe(
      false,
    );
  });

  it("never flushes on top of a send that is already going out", () => {
    expect(canFlushQueuedMessage({ ...flushableThread, isSendBusy: true })).toBe(false);
    expect(canFlushQueuedMessage({ ...flushableThread, isSendInFlight: true })).toBe(false);
  });

  it("leaves a disconnected thread alone so no error silently revives it", () => {
    expect(canFlushQueuedMessage({ ...flushableThread, phase: "disconnected" })).toBe(false);
  });
});

describe("formatQueuedMessagePreview", () => {
  it("uses the first non-empty line of the prompt", () => {
    expect(formatQueuedMessagePreview({ text: "\n  fix the build  \nmore", imageCount: 0 })).toBe(
      "fix the build",
    );
  });

  it("falls back to the image count for an image-only prompt", () => {
    expect(formatQueuedMessagePreview({ text: "", imageCount: 1 })).toBe("1 image");
    expect(formatQueuedMessagePreview({ text: "   ", imageCount: 3 })).toBe("3 images");
  });

  it("has a label for an entry with nothing to show", () => {
    expect(formatQueuedMessagePreview({ text: "", imageCount: 0 })).toBe("Empty message");
  });
});
