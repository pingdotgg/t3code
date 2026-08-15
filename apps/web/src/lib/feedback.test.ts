import { describe, expect, it } from "vite-plus/test";

import { buildWebFeedbackIssueUrl } from "./feedback";

describe("buildWebFeedbackIssueUrl", () => {
  it("identifies the desktop shell and includes browser runtime details", () => {
    const url = new URL(
      buildWebFeedbackIssueUrl({
        appVersion: "2.4.6",
        isDesktop: true,
        navigator: { platform: "MacIntel", userAgent: "Electron/39.0.0" },
        feedbackType: "bug",
      }),
    );

    expect(url.searchParams.get("environment")).toBe("T3 Code Desktop; MacIntel; Electron/39.0.0");
  });

  it("identifies the browser surface", () => {
    const url = new URL(
      buildWebFeedbackIssueUrl({
        appVersion: "2.4.6",
        isDesktop: false,
        navigator: { platform: "Linux x86_64", userAgent: "Firefox/141" },
        feedbackType: "feature",
      }),
    );

    expect(url.searchParams.get("environment")).toBe("T3 Code Web; Linux x86_64; Firefox/141");
  });
});
