import { describe, expect, it } from "vite-plus/test";

import { buildFeedbackIssueUrl } from "./feedback.ts";

describe("buildFeedbackIssueUrl", () => {
  it.each([
    ["bug", "bug_report.yml", "Bug: "],
    ["feature", "feature_request.yml", "Feature: "],
  ] as const)("opens the %s issue form with its prefills", (type, template, title) => {
    const url = new URL(
      buildFeedbackIssueUrl(
        {
          appVersion: "1.2.3",
          surface: "T3 Code Desktop",
          platform: "MacIntel; Electron 39",
        },
        type,
      ),
    );

    expect(url.origin + url.pathname).toBe("https://github.com/pingdotgg/t3code/issues/new");
    expect(url.searchParams.get("template")).toBe(template);
    expect(url.searchParams.get("title")).toBe(title);
    expect(url.searchParams.get("version")).toBe("1.2.3");
    expect(url.searchParams.get("environment")).toBe("T3 Code Desktop; MacIntel; Electron 39");
    expect(url.searchParams.get("body")).toContain("- Version: 1.2.3");
    expect(url.searchParams.get("body")).toContain("- Surface: T3 Code Desktop");
    expect(url.searchParams.get("references")).toBe(url.searchParams.get("body"));
  });

  it("uses readable fallbacks when metadata is unavailable", () => {
    const url = new URL(
      buildFeedbackIssueUrl({ appVersion: " ", surface: "", platform: "\t" }, "bug"),
    );

    expect(url.searchParams.get("version")).toBe("Unknown");
    expect(url.searchParams.get("environment")).toBe("T3 Code; Unknown");
  });
});
