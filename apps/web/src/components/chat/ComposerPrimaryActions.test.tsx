import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const stageArtworkState = vi.hoisted(() => ({
  mode: "none" as "artwork" | "none",
  variant: null as "nightly" | "dev" | null,
}));

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => stageArtworkState.mode,
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: ({ variant }: { variant: string }) => `stage-${variant}`,
  useSidebarStageBackdropVariant: (enabled = true) => (enabled ? stageArtworkState.variant : null),
}));

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

function renderPendingActions(
  isRunning: boolean,
  overrides: Partial<ComponentProps<typeof ComposerPrimaryActions>> = {},
) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      canOperateThread: true,
      pendingAction: {
        questionIndex: 0,
        isLastQuestion: true,
        canAdvance: true,
        isResponding: false,
        isComplete: true,
      },
      isRunning,
      canInterrupt: isRunning,
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
      ...overrides,
    }),
  );
}

function renderSendButton(
  sendDisabledReason: string | null = null,
  overrides: Partial<ComponentProps<typeof ComposerPrimaryActions>> = {},
) {
  return renderToStaticMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      canOperateThread: true,
      pendingAction: null,
      isRunning: false,
      canInterrupt: false,
      showPlanFollowUpPrompt: false,
      promptHasText: true,
      isSendBusy: false,
      sendDisabledReason,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent: true,
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
      ...overrides,
    }),
  );
}

afterEach(() => {
  stageArtworkState.mode = "none";
  stageArtworkState.variant = null;
});

describe("ComposerPrimaryActions", () => {
  it("disables and labels the send button while feedback is uploading", () => {
    const markup = renderSendButton("Sending feedback");

    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-label="Sending feedback"');
  });

  it("offers Stop generation while a running turn is waiting for user input", () => {
    expect(renderPendingActions(true)).toContain('aria-label="Stop generation"');
  });

  it("does not offer Stop generation for a pending request without a running turn", () => {
    expect(renderPendingActions(false)).not.toContain('aria-label="Stop generation"');
  });

  it("puts the Compact chip ahead of the leading actions in reading and focus order", () => {
    const markup = renderSendButton(null, {
      compactBeforeSendTokens: 169_000,
      leadingActions: createElement("button", { type: "button" }, "Attach"),
    });

    const chip = markup.indexOf("Compact 169k tokens of history before sending");
    const attach = markup.indexOf("Attach</button>");
    const send = markup.indexOf('aria-label="Compact and send"');
    expect(chip).toBeGreaterThan(-1);
    expect(attach).toBeGreaterThan(chip);
    expect(send).toBeGreaterThan(attach);
  });

  it("keeps the leading actions before every primary action", () => {
    const leadingActions = createElement("button", { type: "button" }, "Attach");
    const planFollowUp = { leadingActions, showPlanFollowUpPrompt: true };
    const cases = [
      [renderSendButton(null, { leadingActions }), 'aria-label="Submit message"'],
      [renderPendingActions(false, { leadingActions }), ">Submit</button>"],
      [renderSendButton(null, planFollowUp), ">Refine</button>"],
      [renderSendButton(null, { ...planFollowUp, promptHasText: false }), ">Implement</button>"],
      [
        renderSendButton(null, { leadingActions, canInterrupt: true, hasSendableContent: false }),
        'aria-label="Stop generation"',
      ],
    ] as const;

    for (const [markup, primaryAction] of cases) {
      const attach = markup.indexOf("Attach</button>");
      expect(attach).toBeGreaterThan(-1);
      expect(markup.indexOf(primaryAction)).toBeGreaterThan(attach);
    }
  });

  it("renders stage artwork inside the send button when artwork identification is active", () => {
    stageArtworkState.mode = "artwork";
    stageArtworkState.variant = "nightly";

    const markup = renderSendButton();

    expect(markup).toContain("stage-nightly");
  });

  it("hides stage artwork when artwork identification is inactive", () => {
    stageArtworkState.variant = "nightly";

    const markup = renderSendButton();

    expect(markup).not.toContain("stage-nightly");
  });
});
