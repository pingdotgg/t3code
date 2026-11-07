import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ThreadPullRequestLink } from "@t3tools/contracts";

export const DASHBOARD_WEEKS = 26;
const DAY_MS = 86_400_000;

export interface DashboardPullRequest {
  readonly link: ThreadPullRequestLink;
  readonly thread: EnvironmentThreadShell;
  readonly at: string;
}

export interface DraftDashboardData {
  /** Sessions started per local day, oldest first, DASHBOARD_WEEKS * 7 cells ending on today's week. */
  readonly activity: ReadonlyArray<number>;
  readonly activityTotal: number;
  readonly recent: ReadonlyArray<EnvironmentThreadShell>;
  readonly pullRequests: ReadonlyArray<DashboardPullRequest>;
  readonly sessionsThisMonth: number;
  readonly sessionsLastMonth: number;
  readonly mergedThisMonth: number;
  readonly mergedLastMonth: number;
}

const localDayIndex = (ms: number) => {
  const date = new Date(ms);
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
};

const monthKey = (ms: number) => {
  const date = new Date(ms);
  return date.getFullYear() * 12 + date.getMonth();
};

export function deriveDraftDashboard(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  nowMs: number,
): DraftDashboardData {
  const today = localDayIndex(nowMs);
  // Columns are weeks starting Sunday; the last column holds today.
  const lastDay = today + (6 - new Date(nowMs).getDay());
  const firstDay = lastDay - DASHBOARD_WEEKS * 7 + 1;
  const activity = Array.from<number>({ length: DASHBOARD_WEEKS * 7 }).fill(0);
  const thisMonth = monthKey(nowMs);
  let activityTotal = 0;
  let sessionsThisMonth = 0;
  let sessionsLastMonth = 0;
  let mergedThisMonth = 0;
  let mergedLastMonth = 0;
  const pullRequests = new Map<string, DashboardPullRequest>();
  const live: EnvironmentThreadShell[] = [];

  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    live.push(thread);
    const createdMs = Date.parse(thread.createdAt);
    const day = localDayIndex(createdMs);
    if (day >= firstDay && day <= lastDay) {
      activity[day - firstDay]! += 1;
      activityTotal += 1;
    }
    const month = monthKey(createdMs);
    if (month === thisMonth) sessionsThisMonth += 1;
    else if (month === thisMonth - 1) sessionsLastMonth += 1;

    for (const link of thread.pullRequests) {
      if (link.source === "stack-dismissed" || link.snapshot === null) continue;
      if (pullRequests.has(link.url)) continue;
      pullRequests.set(link.url, {
        link,
        thread,
        at: link.snapshot.updatedAt ?? link.linkedAt,
      });
      const mergedAt = link.snapshot.mergedAt;
      if (mergedAt) {
        const mergedMonth = monthKey(Date.parse(mergedAt));
        if (mergedMonth === thisMonth) mergedThisMonth += 1;
        else if (mergedMonth === thisMonth - 1) mergedLastMonth += 1;
      }
    }
  }

  const lastActive = (thread: EnvironmentThreadShell) =>
    thread.latestUserMessageAt ?? thread.updatedAt;
  live.sort((a, b) => lastActive(b).localeCompare(lastActive(a)));

  return {
    activity,
    activityTotal,
    recent: live,
    pullRequests: [...pullRequests.values()].sort((a, b) => b.at.localeCompare(a.at)),
    sessionsThisMonth,
    sessionsLastMonth,
    mergedThisMonth,
    mergedLastMonth,
  };
}
