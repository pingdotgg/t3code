import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { ComposerPrimaryActions, formatPendingPrimaryActionLabel } from "./ComposerPrimaryActions";

const activeTurnProps = {
  compact: false,
  pendingAction: null,
  showPlanFollowUpPrompt: false,
  promptHasText: false,
  isSendBusy: false,
  isConnecting: false,
  isEnvironmentUnavailable: false,
  isPreparingWorktree: false,
  preserveComposerFocusOnPointerDown: false,
  onPreviousPendingQuestion: () => {},
  onInterrupt: () => {},
  onImplementPlanInNewThread: () => {},
} as const;

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

describe("active-turn primary action", () => {
  it("shows stop while the active composer is empty", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerPrimaryActions, {
        ...activeTurnProps,
        isRunning: true,
        hasSendableContent: false,
      }),
    );

    expect(markup).toContain('aria-label="Stop generation"');
    expect(markup).not.toContain("steer active turn");
  });

  it("replaces stop with send while the active composer has content", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerPrimaryActions, {
        ...activeTurnProps,
        isRunning: true,
        hasSendableContent: true,
      }),
    );

    expect(markup).toContain('aria-label="Send message to steer active turn"');
    expect(markup).not.toContain('aria-label="Stop generation"');
  });

  it("shows stop for native background work without active-turn copy", () => {
    const emptyMarkup = renderToStaticMarkup(
      createElement(ComposerPrimaryActions, {
        ...activeTurnProps,
        isRunning: false,
        canInterrupt: true,
        hasSendableContent: false,
      }),
    );
    const contentMarkup = renderToStaticMarkup(
      createElement(ComposerPrimaryActions, {
        ...activeTurnProps,
        isRunning: false,
        canInterrupt: true,
        showSecondaryStop: true,
        hasSendableContent: true,
      }),
    );

    expect(contentMarkup).toContain('aria-label="Stop generation"');
    expect(emptyMarkup).toContain('aria-label="Stop generation"');
    expect(contentMarkup).toContain('aria-label="Send message"');
    expect(contentMarkup).not.toContain("steer active turn");
  });

  it("keeps Implement primary with a secondary Stop for background work", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerPrimaryActions, {
        ...activeTurnProps,
        isRunning: false,
        canInterrupt: true,
        showSecondaryStop: true,
        showPlanFollowUpPrompt: true,
        hasSendableContent: false,
      }),
    );

    expect(markup).toContain('data-chat-composer-implement-actions="true"');
    expect(markup).toContain("Implement");
    expect(markup).toContain('aria-label="Stop generation"');
  });

  it("keeps Refine primary with a secondary Stop for background work", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerPrimaryActions, {
        ...activeTurnProps,
        isRunning: false,
        canInterrupt: true,
        showSecondaryStop: true,
        showPlanFollowUpPrompt: true,
        promptHasText: true,
        hasSendableContent: true,
      }),
    );

    expect(markup).toContain("Refine");
    expect(markup).toContain('aria-label="Stop generation"');
    expect(markup).not.toContain('aria-label="Send message"');
  });

  it("keeps the pending question action with a secondary Stop for background work", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerPrimaryActions, {
        ...activeTurnProps,
        pendingAction: {
          questionIndex: 0,
          isLastQuestion: true,
          canAdvance: true,
          isResponding: false,
          isComplete: true,
        },
        isRunning: false,
        canInterrupt: true,
        showSecondaryStop: true,
        hasSendableContent: false,
      }),
    );

    expect(markup).toContain("Submit answer");
    expect(markup).toContain('aria-label="Stop generation"');
  });

  it("does not add background Stop to an active pending question", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerPrimaryActions, {
        ...activeTurnProps,
        pendingAction: {
          questionIndex: 0,
          isLastQuestion: true,
          canAdvance: true,
          isResponding: false,
          isComplete: true,
        },
        isRunning: true,
        showSecondaryStop: true,
        hasSendableContent: false,
      }),
    );

    expect(markup).toContain("Submit answer");
    expect(markup).not.toContain('aria-label="Stop generation"');
  });

  it("does not add background Stop beside active-turn steering", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerPrimaryActions, {
        ...activeTurnProps,
        isRunning: true,
        showSecondaryStop: true,
        hasSendableContent: true,
      }),
    );

    expect(markup).toContain('aria-label="Send message to steer active turn"');
    expect(markup).not.toContain('aria-label="Stop generation"');
  });

  it("keeps Stop reachable when a running turn still has a plan follow-up", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerPrimaryActions, {
        ...activeTurnProps,
        isRunning: true,
        canInterrupt: true,
        showPlanFollowUpPrompt: true,
        hasSendableContent: false,
      }),
    );

    expect(markup).toContain('aria-label="Stop generation"');
    expect(markup).not.toContain("Implement");
    expect(markup).not.toContain("Refine");
    expect(markup).not.toContain('data-chat-composer-implement-actions="true"');
  });
});
