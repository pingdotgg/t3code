import { scopedThreadKey, scopeThreadRef } from "../environment/index.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import { resolveSettledThreadTimestamp, toSortableTimestamp } from "./threadSort.ts";
import { worktreeScopeKey } from "@t3tools/shared/worktreeResource";
function firstValidTimestampMs(...values: Array<string | null | undefined>): number {
  for (const value of values) {
    const timestamp = Date.parse(value ?? "");
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}
export type WorktreeThreadSection = "active" | "snoozed" | "settled";

export type WorktreeThreadClassification = "active" | "snoozed" | "settled";

/** One sidebar row/card: every visible thread sharing a checkout (git
    worktree, or the project workspace root for local-mode threads). */
export interface WorktreeThreadGroup {
  readonly key: string;
  readonly section: WorktreeThreadSection;
  /** Members in creation order (oldest first) — the in-card row order. */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  /** Member classifications aligned with `threads`. */
  readonly classifications: ReadonlyArray<WorktreeThreadClassification>;
  /** Scoped thread keys aligned with `threads` (stable identity for memo props). */
  readonly memberKeys: ReadonlyArray<string>;
}

export function sidebarThreadKey(thread: EnvironmentThreadShell): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

function groupSettledTimestampMs(group: WorktreeThreadGroup): number {
  let latest = 0;
  for (const thread of group.threads) {
    const timestamp = resolveSettledThreadTimestamp(thread);
    if (timestamp !== null) latest = Math.max(latest, toSortableTimestamp(timestamp) ?? 0);
  }
  return latest;
}

function groupSoonestWakeMs(group: WorktreeThreadGroup): number {
  let soonest = Number.POSITIVE_INFINITY;
  for (const [index, thread] of group.threads.entries()) {
    if (group.classifications[index] !== "snoozed") continue;
    soonest = Math.min(soonest, firstValidTimestampMs(thread.snoozedUntil ?? null));
  }
  return soonest;
}

function groupNewestCreatedAtMs(group: WorktreeThreadGroup): number {
  let newest = 0;
  for (const thread of group.threads) {
    newest = Math.max(newest, toSortableTimestamp(thread.createdAt) ?? 0);
  }
  return newest;
}

function groupPinOrderKey(group: WorktreeThreadGroup): string | null {
  let key: string | null = null;
  for (const thread of group.threads) {
    const orderKey = thread.pinOrderKey;
    if (thread.pinnedAt === null || orderKey == null) continue;
    if (key === null || orderKey < key) key = orderKey;
  }
  return key;
}

/**
 * Group per-thread classifications into worktree rows. A worktree with any
 * active member is a full card (settled/snoozed members ride along inside
 * it); with none active it collapses to the snoozed shelf when any member
 * is snoozed, else to the settled tail. Sorting mirrors the per-thread
 * rules: cards hold static creation order (newest worktree on top),
 * snoozed groups order by soonest wake, settled groups by most recent
 * wrap-up.
 */
export function buildWorktreeThreadGroups(
  classified: ReadonlyArray<{
    readonly thread: EnvironmentThreadShell;
    readonly classification: WorktreeThreadClassification;
  }>,
  options?: { readonly activeThreadOrder: ReadonlyArray<string> },
): {
  activeGroups: WorktreeThreadGroup[];
  snoozedGroups: WorktreeThreadGroup[];
  settledGroups: WorktreeThreadGroup[];
} {
  const byKey = new Map<
    string,
    {
      threads: EnvironmentThreadShell[];
      classifications: WorktreeThreadClassification[];
    }
  >();
  for (const { thread, classification } of classified) {
    const key = worktreeScopeKey(thread.environmentId, thread.projectId, thread.worktreePath);
    const entry = byKey.get(key) ?? { threads: [], classifications: [] };
    entry.threads.push(thread);
    entry.classifications.push(classification);
    byKey.set(key, entry);
  }

  const activeGroups: WorktreeThreadGroup[] = [];
  const snoozedGroups: WorktreeThreadGroup[] = [];
  const settledGroups: WorktreeThreadGroup[] = [];
  for (const [key, entry] of byKey) {
    const order = entry.threads
      .map((_, index) => index)
      .sort(
        (left, right) =>
          (toSortableTimestamp(entry.threads[left]!.createdAt) ?? 0) -
            (toSortableTimestamp(entry.threads[right]!.createdAt) ?? 0) ||
          entry.threads[left]!.id.localeCompare(entry.threads[right]!.id),
      );
    const threads = order.map((index) => entry.threads[index]!);
    const classifications = order.map((index) => entry.classifications[index]!);
    const memberKeys = threads.map(sidebarThreadKey);
    const section: WorktreeThreadSection = classifications.includes("active")
      ? "active"
      : classifications.includes("snoozed")
        ? "snoozed"
        : "settled";
    const group: WorktreeThreadGroup = {
      key,
      section,
      threads,
      classifications,
      memberKeys,
    };
    if (section === "active") activeGroups.push(group);
    else if (section === "snoozed") snoozedGroups.push(group);
    else settledGroups.push(group);
  }

  const activeRank = new Map(options?.activeThreadOrder.map((key, index) => [key, index]));
  const groupRank = (group: WorktreeThreadGroup) =>
    Math.min(...group.memberKeys.map((key) => activeRank.get(key) ?? Number.POSITIVE_INFINITY));
  activeGroups.sort((left, right) => {
    if (options) {
      const order = groupRank(left) - groupRank(right);
      if (Number.isFinite(order) && order !== 0) return order;
    }

    const leftPin = groupPinOrderKey(left);
    const rightPin = groupPinOrderKey(right);
    if (leftPin !== null || rightPin !== null) {
      if (leftPin === null) return 1;
      if (rightPin === null) return -1;
      const pinnedOrder = leftPin.localeCompare(rightPin);
      if (pinnedOrder !== 0) return pinnedOrder;
    }
    return (
      groupNewestCreatedAtMs(right) - groupNewestCreatedAtMs(left) ||
      left.key.localeCompare(right.key)
    );
  });
  snoozedGroups.sort(
    (left, right) =>
      groupSoonestWakeMs(left) - groupSoonestWakeMs(right) || left.key.localeCompare(right.key),
  );
  settledGroups.sort(
    (left, right) =>
      groupSettledTimestampMs(right) - groupSettledTimestampMs(left) ||
      left.key.localeCompare(right.key),
  );
  return { activeGroups, snoozedGroups, settledGroups };
}

/**
 * The thread a collapsed (slim) group row stands in for: the route thread
 * when it's a member (so highlight and pull-into-view keep pointing at what
 * the user has open), otherwise the member matching the shelf's own sort
 * story — soonest wake for snoozed groups, most recent wrap-up for settled
 * ones, newest member for cards.
 */
export function pickWorktreeGroupRepresentative(
  group: WorktreeThreadGroup,
  routeThreadKey: string | null,
): EnvironmentThreadShell {
  if (routeThreadKey !== null) {
    const routeMember = group.threads.find((thread) => sidebarThreadKey(thread) === routeThreadKey);
    if (routeMember !== undefined) return routeMember;
  }
  if (group.section === "snoozed") {
    let best: EnvironmentThreadShell | null = null;
    let bestWake = Number.POSITIVE_INFINITY;
    for (const [index, thread] of group.threads.entries()) {
      if (group.classifications[index] !== "snoozed") continue;
      const wake = firstValidTimestampMs(thread.snoozedUntil ?? null);
      if (wake < bestWake || best === null) {
        best = thread;
        bestWake = wake;
      }
    }
    if (best !== null) return best;
  }
  if (group.section === "settled") {
    let best: EnvironmentThreadShell | null = null;
    let bestMs = Number.NEGATIVE_INFINITY;
    for (const thread of group.threads) {
      const timestamp = resolveSettledThreadTimestamp(thread);
      const ms = timestamp === null ? 0 : (toSortableTimestamp(timestamp) ?? 0);
      if (ms > bestMs || best === null) {
        best = thread;
        bestMs = ms;
      }
    }
    if (best !== null) return best;
  }
  return group.threads.reduce((newest, thread) =>
    (toSortableTimestamp(thread.createdAt) ?? 0) >= (toSortableTimestamp(newest.createdAt) ?? 0)
      ? thread
      : newest,
  );
}
