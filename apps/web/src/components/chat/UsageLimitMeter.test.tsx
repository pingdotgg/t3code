import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { UsageLimitMeter } from "./UsageLimitMeter";
import type { UsageLimitMeterModel } from "./UsageLimitMeter.logic";

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ render }: { render: ReactNode }) => <div>{render}</div>,
}));

vi.mock("../usage/UsageLimits", () => ({
  LimitWindows: ({ windows }: { windows: ReadonlyArray<{ label: string }> }) => (
    <div data-testid="limit-windows">{windows.map((window) => window.label).join(",")}</div>
  ),
}));

const NOW = Date.parse("2026-03-23T12:00:00.000Z");

function model(usedPercent: number): UsageLimitMeterModel {
  return {
    instanceId: ProviderInstanceId.make("claude-agent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: null,
    plan: "Claude Max",
    limits: {
      checkedAt: "2026-03-23T11:55:00.000Z",
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent,
          resetsAt: "2026-03-23T14:10:00.000Z",
          windowDurationMins: 300,
        },
      ],
    },
  };
}

describe("UsageLimitMeter", () => {
  it("names the tightest window in the trigger and lists every window in the popover", () => {
    const markup = renderToStaticMarkup(<UsageLimitMeter model={model(42)} now={NOW} />);

    expect(markup).toContain('aria-label="Session: 58% left, resets in 2h 10m"');
    expect(markup).toContain("Claude · Claude Max");
    expect(markup).toContain('data-testid="limit-windows">Session<');
    expect(markup).toContain(
      'fill="color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)"',
    );
  });

  it("switches the glyph to the error colour when little quota is left", () => {
    const markup = renderToStaticMarkup(<UsageLimitMeter model={model(95)} now={NOW} />);

    expect(markup).toContain('aria-label="Session: 5% left, resets in 2h 10m"');
    expect(markup).toContain('fill="var(--color-error)"');
  });
});
