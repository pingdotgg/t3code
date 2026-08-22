import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { CodexLimitsPanel } from "./CodexLimitsPanel";

describe("CodexLimitsPanel", () => {
  it("shows both limit windows and the next banked reset expiry", () => {
    const html = renderToStaticMarkup(
      <CodexLimitsPanel
        label="Codex"
        now={1_776_900_000_000}
        rateLimits={{
          primary: { usedPercent: 72, resetsAt: 1_777_000_000, windowDurationMins: 300 },
          secondary: { usedPercent: 46, resetsAt: 1_777_604_800, windowDurationMins: 10_080 },
          resetCredits: {
            availableCount: 2,
            credits: [
              {
                id: "reset-1",
                status: "available",
                grantedAt: 1_776_000_000,
                expiresAt: 1_778_000_000,
                title: "Referral reset",
              },
            ],
          },
        }}
        onUseReset={() => undefined}
      />,
    );

    expect(html).toContain("5-hour limit");
    expect(html).toContain("72% used");
    expect(html).toContain("Weekly limit");
    expect(html).toContain("2 banked resets");
    expect(html).toContain("Use reset");
    expect(html).toContain("Next expires");
  });

  it("does not offer an unavailable reset", () => {
    const html = renderToStaticMarkup(
      <CodexLimitsPanel
        label="Codex"
        now={1_776_900_000_000}
        rateLimits={{ resetCredits: { availableCount: 0, credits: [] } }}
        onUseReset={() => undefined}
      />,
    );

    expect(html).toContain("No banked resets");
    expect(html).not.toContain("Use reset");
  });
});
