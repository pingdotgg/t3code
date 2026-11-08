import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import { DASHBOARD_WEEKS, deriveDraftDashboard } from "./draftDashboard.logic";

const shell = (id: string, createdAt: string, extra: Partial<EnvironmentThreadShell> = {}) =>
  ({
    environmentId: "env",
    id,
    title: id,
    createdAt,
    updatedAt: createdAt,
    latestUserMessageAt: null,
    archivedAt: null,
    deletedAt: null,
    pullRequests: [],
    ...extra,
  }) as unknown as EnvironmentThreadShell;

const pr = (url: string, mergedAt: string | null, source = "created") => ({
  url,
  source,
  linkedAt: "2026-11-01T00:00:00.000Z",
  snapshot: {
    state: mergedAt ? "merged" : "open",
    title: url,
    isDraft: false,
    updatedAt: null,
    mergedAt,
  },
});

describe("deriveDraftDashboard", () => {
  it("buckets sessions by day and month, dedupes PRs, and skips archived threads", () => {
    const now = new Date(2026, 10, 7, 12).getTime();
    const today = new Date(2026, 10, 7, 9).toISOString();
    const lastMonth = new Date(2026, 9, 20, 9).toISOString();
    const shared = pr("https://x/pr/1", new Date(2026, 10, 2).toISOString());
    const data = deriveDraftDashboard(
      [
        shell("a", today, { pullRequests: [shared] } as never),
        shell("b", today, {
          latestUserMessageAt: new Date(2026, 10, 7, 11).toISOString(),
          pullRequests: [shared, pr("https://x/pr/2", null, "stack-dismissed")],
        } as never),
        shell("c", lastMonth),
        shell("d", today, { archivedAt: today }),
      ],
      now,
    );

    expect(data.activity).toHaveLength(DASHBOARD_WEEKS * 7);
    // Today is a Saturday, the last cell of the final week.
    expect(data.activity.at(-1)).toBe(2);
    expect(data.activityTotal).toBe(3);
    expect(data.recent.map((thread) => thread.id)).toEqual(["b", "a", "c"]);
    expect(data.pullRequests.map((entry) => entry.link.url)).toEqual(["https://x/pr/1"]);
    expect([data.sessionsThisMonth, data.sessionsLastMonth]).toEqual([2, 1]);
    expect([data.mergedThisMonth, data.mergedLastMonth]).toEqual([1, 0]);
  });
});
