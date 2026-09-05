import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ render }: { render: ReactNode }) => <div>{render}</div>,
}));

vi.mock("~/hooks/useSettings", () => ({
  usePrimarySettings: (selector?: (settings: { timestampFormat: "locale" }) => unknown) =>
    selector ? selector({ timestampFormat: "locale" }) : { timestampFormat: "locale" },
}));

import { ComposerUsageMeter } from "./ComposerUsageMeter";

describe("ComposerUsageMeter", () => {
  it("labels the control with the current provider and keeps usage out of the context meter", () => {
    const markup = renderToStaticMarkup(
      <ComposerUsageMeter
        usage={{
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

    expect(markup).toContain('aria-label="Codex usage 55% used"');
    expect(markup).toContain(">55%<");
    expect(markup).toContain("Usage");
    expect(markup).toContain("Session");
    expect(markup).toContain("Weekly");
    expect(markup).not.toContain("Context Window");
  });
});
