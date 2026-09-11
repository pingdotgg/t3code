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

vi.mock("../usage/UsageLimits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../usage/UsageLimits")>()),
  LimitWindows: ({ windows }: { windows: ReadonlyArray<{ label: string }> }) => (
    <div data-testid="limit-windows">{windows.map((window) => window.label).join(",")}</div>
  ),
}));

const NOW = Date.parse("2026-03-23T12:00:00.000Z");

function model(
  usedPercent: number,
  limits: Partial<UsageLimitMeterModel["limits"]> = {},
): UsageLimitMeterModel {
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
      ...limits,
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

  it("drops windows whose reset has passed from the popover", () => {
    const markup = renderToStaticMarkup(
      <UsageLimitMeter
        model={model(95, {
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "Session",
              usedPercent: 95,
              resetsAt: "2026-03-23T11:00:00.000Z",
              windowDurationMins: 300,
            },
            {
              id: "seven_day",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 20,
              resetsAt: "2026-03-30T00:00:00.000Z",
              windowDurationMins: 10_080,
            },
          ],
        })}
        now={NOW}
      />,
    );

    expect(markup).toContain('aria-label="Weekly: 80% left, resets in 6d 12h"');
    expect(markup).toContain('data-testid="limit-windows">Weekly<');
    expect(markup).not.toContain('fill="var(--color-error)"');
  });

  it("explains an empty popover once every window has reset", () => {
    const markup = renderToStaticMarkup(
      <UsageLimitMeter
        model={model(95, {
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "Session",
              usedPercent: 95,
              resetsAt: "2026-03-23T11:00:00.000Z",
              windowDurationMins: 300,
            },
          ],
        })}
        now={NOW}
      />,
    );

    expect(markup).toContain('aria-label="Usage limits"');
    expect(markup).toContain("Every window has reset.");
    expect(markup).not.toContain('data-testid="limit-windows"');
  });

  it("summarises banked reset credits", () => {
    const markup = renderToStaticMarkup(
      <UsageLimitMeter
        model={model(42, {
          resetCredits: { availableCount: 2, nextExpiresAt: "2026-03-26T12:00:00.000Z" },
        })}
        now={NOW}
      />,
    );

    expect(markup).toContain("Reset credits");
    expect(markup).toContain("2 banked · expires in 3d 0h");
  });

  it("switches the glyph to the error colour when little quota is left", () => {
    const markup = renderToStaticMarkup(<UsageLimitMeter model={model(95)} now={NOW} />);

    expect(markup).toContain('aria-label="Session: 5% left, resets in 2h 10m"');
    expect(markup).toContain('fill="var(--color-error)"');
  });
});
