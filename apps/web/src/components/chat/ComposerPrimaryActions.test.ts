import { createElement, type ComponentProps } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ComposerPrimaryActions, formatPendingPrimaryActionLabel } from "./ComposerPrimaryActions";

function renderComposerPrimaryActions(
  overrides: Partial<ComponentProps<typeof ComposerPrimaryActions>> = {},
) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: false,
      pendingAction: null,
      isRunning: false,
      turnQueueStatus: "idle",
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: false,
      isConnecting: false,
      isPreparingWorktree: false,
      hasSendableContent: true,
      onPreviousPendingQuestion: () => undefined,
      onInterrupt: () => undefined,
      onImplementPlanInNewThread: async () => undefined,
      ...overrides,
    }),
  );
}

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

describe("ComposerPrimaryActions", () => {
  it("uses the send icon state while idle", () => {
    const html = renderComposerPrimaryActions();

    expect(html).toContain('aria-label="Send"');
  });

  it("uses the interrupt icon state while running with an empty draft", () => {
    const html = renderComposerPrimaryActions({
      isRunning: true,
      turnQueueStatus: "queued",
      hasSendableContent: false,
    });

    expect(html).toContain('aria-label="Interrupt turn"');
    expect(html).not.toContain('aria-label="Add to queue"');
  });

  it("uses the queue icon state while running with draft content", () => {
    const html = renderComposerPrimaryActions({
      isRunning: true,
      turnQueueStatus: "queued",
      hasSendableContent: true,
    });

    expect(html).toContain('aria-label="Add to queue"');
  });

  it("uses the queue icon state while paused", () => {
    const html = renderComposerPrimaryActions({
      turnQueueStatus: "paused",
      hasSendableContent: true,
    });

    expect(html).toContain('aria-label="Add to queue"');
  });

  it("keeps compact queue actions icon-sized with the same aria label", () => {
    const html = renderComposerPrimaryActions({
      compact: true,
      turnQueueStatus: "paused",
      hasSendableContent: true,
    });

    expect(html).toContain('aria-label="Add to queue"');
  });

  it("shows a busy spinner label while preparing worktree", () => {
    const html = renderComposerPrimaryActions({
      isPreparingWorktree: true,
    });

    expect(html).toContain('aria-label="Preparing worktree"');
  });
});
