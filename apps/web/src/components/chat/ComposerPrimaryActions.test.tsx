import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

const noop = vi.fn();

function renderActions(overrides: Partial<ComponentProps<typeof ComposerPrimaryActions>> = {}) {
  return renderToStaticMarkup(
    <ComposerPrimaryActions
      compact={false}
      pendingAction={null}
      isRunning={false}
      showPlanFollowUpPrompt={false}
      promptHasText={false}
      isSendBusy={false}
      isConnecting={false}
      isPreparingWorktree={false}
      hasSendableContent
      onPreviousPendingQuestion={noop}
      onInterrupt={noop}
      onImplementPlanInNewThread={noop}
      {...overrides}
    />,
  );
}

describe("ComposerPrimaryActions", () => {
  it("uses compact pending-question controls when space is tight", () => {
    const html = renderActions({
      compact: true,
      pendingAction: {
        questionIndex: 1,
        isLastQuestion: true,
        canAdvance: true,
        isResponding: false,
        isComplete: true,
      },
    });

    expect(html).toContain('aria-label="Previous question"');
    expect(html).toContain(">Submit<");
    expect(html).not.toContain(">Previous<");
    expect(html).not.toContain("Submit answers");
  });

  it("keeps full pending-question copy in the expanded footer", () => {
    const html = renderActions({
      pendingAction: {
        questionIndex: 1,
        isLastQuestion: true,
        canAdvance: true,
        isResponding: false,
        isComplete: true,
      },
    });

    expect(html).toContain(">Previous<");
    expect(html).toContain("Submit answers");
  });

  it("uses separate pills for compact implement actions", () => {
    const html = renderActions({
      compact: true,
      showPlanFollowUpPrompt: true,
    });

    expect(html).toContain(">Implement<");
    expect(html).toContain('aria-label="Implementation actions"');
    expect(html).not.toContain("rounded-l-none");
  });
});
