import type { PostHogReport } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  doneReports,
  groupInboxReports,
  isReportUnread,
  nextFocusedReportId,
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
  it("splits reports into Needs you, Watching, and Done", () => {
    const reports = [
      report({ id: "a", status: "ready" }),
      report({ id: "b", status: "pending_input" }),
      report({ id: "c", status: "in_progress" }),
      report({ id: "d", status: "failed" }),
      report({ id: "e", status: "potential" }),
      report({ id: "f", status: "resolved" }),
      report({ id: "g", status: "suppressed" }),
    ];

    expect(
      groupInboxReports(reports).map((section) => [section.id, section.reports.length]),
    ).toEqual([
      ["needs-you", 2],
      ["watching", 3],
    ]);
    expect(doneReports(reports).map((entry) => entry.id)).toEqual(["f", "g"]);
  });

  it("orders each section newest first", () => {
    const reports = [
      report({ id: "old", status: "ready", updated_at: "2026-01-01T00:00:00Z" }),
      report({ id: "new", status: "ready", updated_at: "2026-02-01T00:00:00Z" }),
    ];

    expect(groupInboxReports(reports)[0]?.reports.map((entry) => entry.id)).toEqual(["new", "old"]);
  });

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
});
