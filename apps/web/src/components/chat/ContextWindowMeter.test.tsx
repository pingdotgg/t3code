import { EventId, TurnId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/hooks/useSettings", () => ({
  usePrimarySettings: (selector?: (settings: { timestampFormat: "locale" }) => unknown) =>
    selector ? selector({ timestampFormat: "locale" }) : { timestampFormat: "locale" },
}));

import { deriveLatestContextWindowSnapshot } from "~/lib/contextWindow";
import { ContextWindowMeter } from "./ContextWindowMeter";

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ closeDelay, render }: { closeDelay: number; render: ReactNode }) => (
    <div data-close-delay={closeDelay}>{render}</div>
  ),
}));

const usage = deriveLatestContextWindowSnapshot([
  {
    id: EventId.make("activity-1"),
    tone: "info",
    kind: "context-window.updated",
    summary: "Context updated",
    payload: { usedTokens: 100_000, maxTokens: 1_000_000 },
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-08-24T12:00:00.000Z",
  },
]);

if (!usage) {
  throw new Error("The context window test fixture did not produce a snapshot.");
}

describe("ContextWindowMeter", () => {
  it("keeps the hover popover open while the pointer moves to the compact button", () => {
    const markup = renderToStaticMarkup(<ContextWindowMeter usage={usage} onCompact={() => {}} />);

    expect(markup).toContain('data-close-delay="150"');
    expect(markup).toContain("Compact context");
  });

  it("closes an informational hover popover without delay", () => {
    const markup = renderToStaticMarkup(<ContextWindowMeter usage={usage} />);

    expect(markup).toContain('data-close-delay="0"');
    expect(markup).not.toContain("Compact context");
  });

  it("explains why the compact action is disabled", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter
        usage={usage}
        onCompact={() => {}}
        compactDisabled
        compactDisabledReason="Send or clear your draft before compacting"
      />,
    );

    expect(markup).toContain('disabled=""');
    expect(markup).toContain(">Send or clear your draft before compacting<");
    expect(markup).not.toContain('aria-label="Send or clear your draft before compacting"');
  });

  it("shows the current provider's usage bars without replacing context window stats", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter
        usage={usage}
        providerUsage={{
          providerLabel: "Codex",
          usedPercent: 55,
          usageLimits: {
            checkedAt: "2026-08-16T00:00:00.000Z",
            windows: [
              { id: "primary", kind: "session", label: "Session", usedPercent: 20 },
              { id: "secondary", kind: "weekly", label: "Weekly", usedPercent: 55 },
            ],
          },
        }}
      />,
    );

    expect(markup).toContain("Context Window");
    expect(markup).toContain("Usage");
    expect(markup).toContain("Codex");
    expect(markup).toContain("Session");
    expect(markup).toContain("Weekly");
    expect(markup).toContain("80% remaining");
    expect(markup).toContain("45% remaining");
    expect(markup).toContain('aria-label="Context window 10% used"');
  });
});
