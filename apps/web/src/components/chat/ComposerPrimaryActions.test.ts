import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const stageMock = vi.hoisted(() => ({
  artworkEnabled: false,
  variant: null as "dev" | "nightly" | null,
}));

vi.mock("~/hooks/useSettings", () => ({
  useDefaultEnvironmentArtworkEnabled: () => stageMock.artworkEnabled,
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: ({ variant }: { variant: "dev" | "nightly" }) => `stage-${variant}`,
  useSidebarStageBackdropVariant: (enabled: boolean) => (enabled ? stageMock.variant : null),
}));

import { ComposerPrimaryActions, formatPendingPrimaryActionLabel } from "./ComposerPrimaryActions";

function renderPendingActions(isRunning: boolean) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: {
        questionIndex: 0,
        isLastQuestion: true,
        canAdvance: true,
        isResponding: false,
        isComplete: true,
      },
      isRunning,
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: false,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

function renderStandaloneStop() {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: null,
      isRunning: true,
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: false,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}

function renderSendAction(
  input: Partial<{
    hasSendableContent: boolean;
    isConnecting: boolean;
    isSendBusy: boolean;
    isEnvironmentUnavailable: boolean;
    sendDisabledReason: string | null;
  }> = {},
) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      pendingAction: null,
      isRunning: false,
      showPlanFollowUpPrompt: false,
      promptHasText: false,
      isSendBusy: input.isSendBusy ?? false,
      sendDisabledReason: input.sendDisabledReason ?? null,
      isConnecting: input.isConnecting ?? false,
      isEnvironmentUnavailable: input.isEnvironmentUnavailable ?? false,
      isPreparingWorktree: false,
      hasSendableContent: input.hasSendableContent ?? true,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
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
  it("offers Stop generation while a running turn is waiting for user input", () => {
    expect(renderPendingActions(true)).toContain('aria-label="Stop generation"');
  });

  it("does not offer Stop generation for a pending request without a running turn", () => {
    expect(renderPendingActions(false)).not.toContain('aria-label="Stop generation"');
  });

  it("matches the small pending action size without changing the standalone size", () => {
    expect(renderPendingActions(true)).toContain("size-8 sm:size-7");
    expect(renderStandaloneStop()).toContain("size-8 sm:h-8 sm:w-8");
    expect(renderStandaloneStop()).not.toContain("sm:size-7");
  });

  it.each(["dev", "nightly"] as const)(
    "uses %s artwork on the send action in artwork mode",
    (variant) => {
      stageMock.artworkEnabled = true;
      stageMock.variant = variant;

      const markup = renderSendAction();

      expect(markup).toContain(`stage-${variant}`);
      expect(markup).toContain("bg-transparent");
      expect(markup).toContain('aria-label="Send message"');
    },
  );

  it("keeps the standard send action when default-theme artwork is disabled", () => {
    stageMock.artworkEnabled = false;
    stageMock.variant = "dev";

    const markup = renderSendAction();

    expect(markup).not.toContain("stage-dev");
    expect(markup).toContain("bg-message-action");
  });

  it("preserves busy and disabled labels with artwork", () => {
    stageMock.artworkEnabled = true;
    stageMock.variant = "nightly";

    expect(renderSendAction({ isSendBusy: true })).toContain('aria-label="Sending"');
    expect(renderSendAction({ isEnvironmentUnavailable: true })).toContain(
      'aria-label="Environment disconnected"',
    );
    expect(renderSendAction({ sendDisabledReason: "Choose a provider" })).toContain(
      'aria-label="Choose a provider"',
    );
  });
});
