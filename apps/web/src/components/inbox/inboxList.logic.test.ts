import type { PostHogReport } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  humanizeReportTitle,
  isReportUnread,
  nextFocusedReportId,
  sourceProductLabel,
  summaryLine,
} from "./inboxList.logic";

function report(overrides: Partial<Omit<PostHogReport, "id">> & { id: string }): PostHogReport {
  return {
    title: `Report ${overrides.id}`,
    summary: null,
    status: "ready",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  } as PostHogReport;
}

describe("inbox list", () => {
  it("marks a report unread until it is seen at its current update time", () => {
    const entry = report({ id: "a", updated_at: "2026-02-01T00:00:00Z" });

    expect(isReportUnread(entry, {})).toBe(true);
    expect(isReportUnread(entry, { a: "2026-01-01T00:00:00Z" })).toBe(true);
    expect(isReportUnread(entry, { a: "2026-02-01T00:00:00Z" })).toBe(false);
  });

  it("takes the first sentence of the summary, before any heading", () => {
    expect(
      summaryLine("Checkout fails for 3% of users. It started on Tuesday.\n\n## Impact\nBad."),
    ).toBe("Checkout fails for 3% of users.");
    expect(summaryLine("## Problem\nOnly a heading section.")).toBe("");
    expect(summaryLine(null)).toBe("");
  });

  it("moves focus to the next row when one is archived, and back up at the end", () => {
    expect(nextFocusedReportId(["a", "b", "c"], "b")).toBe("c");
    expect(nextFocusedReportId(["a", "b", "c"], "c")).toBe("b");
    expect(nextFocusedReportId(["a"], "a")).toBe(null);
  });

  it("names PostHog's source products, and passes unknown ones through", () => {
    expect(sourceProductLabel("error_tracking")).toBe("Error tracking");
    expect(sourceProductLabel("conversations")).toBe("Support");
    expect(sourceProductLabel("some_new_product")).toBe("some new product");
  });

  it("strips conventional-commit prefixes from report titles", () => {
    expect(humanizeReportTitle("fix(tasks): Say which limit was hit")).toBe(
      "Say which limit was hit",
    );
    expect(humanizeReportTitle("feat: add the thing")).toBe("Add the thing");
    expect(humanizeReportTitle("fix(desktop)!: drop the flag")).toBe("Drop the flag");
  });

  it("leaves a prefix that is not a conventional-commit type alone", () => {
    expect(humanizeReportTitle("billing: emails are wrong")).toBe("billing: emails are wrong");
    expect(humanizeReportTitle("Fix billing emails")).toBe("Fix billing emails");
  });

  it("keeps the original when stripping would empty the title", () => {
    expect(humanizeReportTitle("chore:")).toBe("chore:");
    expect(humanizeReportTitle("")).toBe("Untitled report");
  });
});
