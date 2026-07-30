import { describe, expect, it } from "vite-plus/test";

import {
  formatPendingPrimaryActionLabel,
  resolveComposerPrimaryAction,
} from "./ComposerPrimaryActions";

describe("formatPendingPrimaryActionLabel", () => {
  it("returns 'Submitting...' while responding", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: false,
        isResponding: true,
        questionIndex: 0,
      }),
    ).toBe("Submitting...");
  });

  it("returns 'Submitting...' while responding regardless of other flags", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: true,
        isResponding: true,
        questionIndex: 3,
      }),
    ).toBe("Submitting...");
  });

  it("returns 'Submit' in compact mode on the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Submit");
  });

  it("returns 'Next' in compact mode when not the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: true,
        isLastQuestion: false,
        isResponding: false,
        questionIndex: 1,
      }),
    ).toBe("Next");
  });

  it("returns 'Next question' when not the last question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: false,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Next question");
  });

  it("returns singular 'Submit answer' on the last question when it is the only question", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 0,
      }),
    ).toBe("Submit answer");
  });

  it("returns plural 'Submit answers' on the last question when there are multiple questions", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 1,
      }),
    ).toBe("Submit answers");
  });

  it("returns plural 'Submit answers' for higher question indices", () => {
    expect(
      formatPendingPrimaryActionLabel({
        compact: false,
        isLastQuestion: true,
        isResponding: false,
        questionIndex: 5,
      }),
    ).toBe("Submit answers");
  });
});

describe("resolveComposerPrimaryAction", () => {
  const idle = {
    isRunning: false,
    queueStatus: "idle" as const,
    isSendBusy: false,
    sendDisabledReason: null,
    isConnecting: false,
    isEnvironmentUnavailable: false,
    isPreparingWorktree: false,
    hasSendableContent: true,
  };

  it("sends when idle with content", () => {
    expect(resolveComposerPrimaryAction(idle)).toEqual({
      kind: "send",
      label: "Send message",
      disabled: false,
    });
  });

  it("queues when a turn is running and the composer has content", () => {
    expect(resolveComposerPrimaryAction({ ...idle, isRunning: true })).toEqual({
      kind: "queue",
      label: "Add to queue",
      disabled: false,
    });
  });

  it("interrupts when a turn is running and the composer is empty", () => {
    expect(
      resolveComposerPrimaryAction({
        ...idle,
        isRunning: true,
        hasSendableContent: false,
      }),
    ).toEqual({
      kind: "interrupt",
      label: "Interrupt turn",
      disabled: false,
    });
  });

  it("keeps queue intent visible for queued and paused states", () => {
    expect(resolveComposerPrimaryAction({ ...idle, queueStatus: "queued" }).kind).toBe("queue");
    expect(resolveComposerPrimaryAction({ ...idle, queueStatus: "paused" }).kind).toBe("queue");
  });

  it("reports connection and worktree preparation states", () => {
    expect(resolveComposerPrimaryAction({ ...idle, isConnecting: true })).toMatchObject({
      kind: "busy",
      label: "Connecting",
      disabled: true,
    });
    expect(resolveComposerPrimaryAction({ ...idle, isPreparingWorktree: true })).toMatchObject({
      kind: "busy",
      label: "Preparing worktree",
      disabled: true,
    });
  });

  it("preserves explicit disabled reasons", () => {
    expect(
      resolveComposerPrimaryAction({
        ...idle,
        sendDisabledReason: "Messages loading",
      }),
    ).toEqual({
      kind: "disabled",
      label: "Messages loading",
      disabled: true,
    });
  });
});
