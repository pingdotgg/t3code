import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ComposerUsageLimitStrip,
  formatUsageLimitCountdown,
  formatUsageLimitStripLabel,
} from "./ComposerUsageLimitStrip";

describe("formatUsageLimitCountdown", () => {
  it("renders hours and minutes compactly", () => {
    expect(formatUsageLimitCountdown(84 * 60_000)).toBe("1h 24m");
    expect(formatUsageLimitCountdown(24 * 60_000)).toBe("24m");
    expect(formatUsageLimitCountdown(60 * 60_000)).toBe("1h 0m");
  });

  it("never rounds a live window down to zero", () => {
    expect(formatUsageLimitCountdown(30_000)).toBe("<1m");
    expect(formatUsageLimitCountdown(0)).toBe("<1m");
  });
});

describe("formatUsageLimitStripLabel", () => {
  it("keeps the window label on one line", () => {
    expect(formatUsageLimitStripLabel({ windowType: "five_hour", remainingMs: 84 * 60_000 })).toBe(
      "5-hour limit reached · resets in 1h 24m",
    );
    expect(formatUsageLimitStripLabel({ windowType: "seven_day", remainingMs: 24 * 60_000 })).toBe(
      "weekly limit reached · resets in 24m",
    );
  });

  it("falls back for unknown windows and missing reset times", () => {
    expect(formatUsageLimitStripLabel({ windowType: "mystery", remainingMs: 60_000 })).toBe(
      "Usage limit reached · resets in 1m",
    );
    expect(formatUsageLimitStripLabel({})).toBe("Usage limit reached · resets soon");
  });
});

describe("ComposerUsageLimitStrip", () => {
  it("docks to the composer's top edge and renders the countdown", () => {
    const markup = renderToStaticMarkup(
      <ComposerUsageLimitStrip
        usageLimit={{
          windowType: "five_hour",
          // Slack so render time cannot floor the countdown into the next minute down.
          resetsAt: Date.now() + 84 * 60_000 + 5_000,
          message: "5-hour usage limit reached.",
          provider: "claudeAgent",
        }}
      />,
    );

    expect(markup).toContain("chat-composer-notice-strip");
    // Mirrors the branch toolbar's dock geometry, one composer width wide.
    expect(markup).toContain("-mb-4");
    expect(markup).toContain("max-w-[calc(48rem-2.75rem)]");
    expect(markup).toContain("5-hour limit reached · resets in 1h 24m");
  });

  it("renders nothing without a usage limit or once the window has reopened", () => {
    expect(renderToStaticMarkup(<ComposerUsageLimitStrip usageLimit={null} />)).toBe("");
    expect(
      renderToStaticMarkup(
        <ComposerUsageLimitStrip
          usageLimit={{ resetsAt: Date.now() - 1_000, message: "Usage limit reached." }}
        />,
      ),
    ).toBe("");
  });
});
