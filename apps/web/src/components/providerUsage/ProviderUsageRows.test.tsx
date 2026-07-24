import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ProviderUsageRows, ProviderUsageSummary } from "./ProviderUsageRows";

describe("ProviderUsageRows", () => {
  it("renders dynamic windows with explicit remaining percentages", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageRows
        timestampFormat="24-hour"
        usageLimits={{
          source: "claudePrint",
          checkedAt: "2026-07-22T12:00:00.000Z",
          windows: [
            { label: "Session", usedPercent: 30 },
            { label: "Weekly (Fable)", usedPercent: 26 },
          ],
        }}
      />,
    );

    expect(markup).toContain("Session");
    expect(markup).toContain("70% remaining");
    expect(markup).toContain("Weekly (Fable)");
    expect(markup).toContain("74% remaining");
  });

  it("renders multiple windows as one compact remaining summary", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageSummary
        usageLimits={{
          source: "claudePrint",
          checkedAt: "2026-07-22T12:00:00.000Z",
          windows: [
            { label: "Session", usedPercent: 84 },
            { label: "Weekly (all models)", usedPercent: 20 },
            { label: "Weekly (Fable)", usedPercent: 32 },
          ],
        }}
      />,
    );

    expect(markup).toContain("Session");
    expect(markup).toContain("16%");
    expect(markup).toContain("Weekly (all models)");
    expect(markup).toContain("80%");
    expect(markup).toContain("Weekly (Fable)");
    expect(markup).toContain("68%");
    expect(markup).toContain("remaining");
    expect(markup).toContain("·");
  });
});
