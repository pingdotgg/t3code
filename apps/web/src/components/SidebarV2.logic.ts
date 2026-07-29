import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import { threadWorktreeScopeKey } from "../worktreeScope";
import {
  firstValidTimestampMs,
  parseTimestampMs,
  resolveSettledTimestamp,
  resolveSidebarV2Status,
  resolveWorkingStartedAt,
} from "./Sidebar.logic";

export type SidebarWorktreeSection = "active" | "snoozed" | "settled";

export type SidebarThreadClassification = "active" | "snoozed" | "settled";

/** One sidebar row/card: every visible thread sharing a checkout (git
    worktree, or the project workspace root for local-mode threads). */
export interface SidebarWorktreeGroup {
  readonly key: string;
  readonly section: SidebarWorktreeSection;
  /** Members in creation order (oldest first) — the in-card row order. */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  /** Member classifications aligned with `threads`. */
  readonly classifications: ReadonlyArray<SidebarThreadClassification>;
  /** Scoped thread keys aligned with `threads` (stable identity for memo props). */
  readonly memberKeys: ReadonlyArray<string>;
}

export function sidebarThreadKey(thread: EnvironmentThreadShell): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

function groupSettledTimestampMs(group: SidebarWorktreeGroup): number {
  let latest = 0;
  for (const thread of group.threads) {
    const timestamp = resolveSettledTimestamp(thread);
    if (timestamp !== null) latest = Math.max(latest, parseTimestampMs(timestamp));
  }
  return latest;
}

function groupSoonestWakeMs(group: SidebarWorktreeGroup): number {
  let soonest = Number.POSITIVE_INFINITY;
  for (const [index, thread] of group.threads.entries()) {
    if (group.classifications[index] !== "snoozed") continue;
    soonest = Math.min(soonest, firstValidTimestampMs(thread.snoozedUntil ?? null));
  }
  return soonest;
}

function groupNewestCreatedAtMs(group: SidebarWorktreeGroup): number {
  let newest = 0;
  for (const thread of group.threads) {
    newest = Math.max(newest, parseTimestampMs(thread.createdAt));
  }
  return newest;
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
export function buildSidebarWorktreeGroups(
  classified: ReadonlyArray<{
    readonly thread: EnvironmentThreadShell;
    readonly classification: SidebarThreadClassification;
  }>,
): {
  activeGroups: SidebarWorktreeGroup[];
  snoozedGroups: SidebarWorktreeGroup[];
  settledGroups: SidebarWorktreeGroup[];
} {
  const byKey = new Map<
    string,
    { threads: EnvironmentThreadShell[]; classifications: SidebarThreadClassification[] }
  >();
  for (const { thread, classification } of classified) {
    const key = threadWorktreeScopeKey(thread);
    const entry = byKey.get(key) ?? { threads: [], classifications: [] };
    entry.threads.push(thread);
    entry.classifications.push(classification);
    byKey.set(key, entry);
  }

  const activeGroups: SidebarWorktreeGroup[] = [];
  const snoozedGroups: SidebarWorktreeGroup[] = [];
  const settledGroups: SidebarWorktreeGroup[] = [];
  for (const [key, entry] of byKey) {
    const order = entry.threads
      .map((_, index) => index)
      .toSorted(
        (left, right) =>
          parseTimestampMs(entry.threads[left]!.createdAt) -
            parseTimestampMs(entry.threads[right]!.createdAt) ||
          entry.threads[left]!.id.localeCompare(entry.threads[right]!.id),
      );
    const threads = order.map((index) => entry.threads[index]!);
    const classifications = order.map((index) => entry.classifications[index]!);
    const memberKeys = threads.map(sidebarThreadKey);
    const section: SidebarWorktreeSection = classifications.includes("active")
      ? "active"
      : classifications.includes("snoozed")
        ? "snoozed"
        : "settled";
    const group: SidebarWorktreeGroup = { key, section, threads, classifications, memberKeys };
    if (section === "active") activeGroups.push(group);
    else if (section === "snoozed") snoozedGroups.push(group);
    else settledGroups.push(group);
  }

  activeGroups.sort(
    (left, right) =>
      groupNewestCreatedAtMs(right) - groupNewestCreatedAtMs(left) ||
      left.key.localeCompare(right.key),
  );
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
  group: SidebarWorktreeGroup,
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
      const timestamp = resolveSettledTimestamp(thread);
      const ms = timestamp === null ? 0 : parseTimestampMs(timestamp);
      if (ms > bestMs || best === null) {
        best = thread;
        bestMs = ms;
      }
    }
    if (best !== null) return best;
  }
  return group.threads.reduce((newest, thread) =>
    parseTimestampMs(thread.createdAt) >= parseTimestampMs(newest.createdAt) ? thread : newest,
  );
}

/** Card-level live status: what the worktree as a whole is doing, ranked by
    how urgently it needs the user (act now > answer > in motion > broken).
    Per-thread Done/Woke signals stay on the member rows — this is only the
    shells-derived aggregate for the card's top-right slot. */
export function resolveWorktreeGroupLiveStatus(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): { kind: "approval" | "input" | "working" | "failed"; workingStartedAt: string | null } | null {
  let hasApproval = false;
  let hasInput = false;
  let hasFailed = false;
  let hasWorking = false;
  let workingStartedAt: string | null = null;
  let workingStartedAtMs = Number.POSITIVE_INFINITY;
  for (const thread of threads) {
    const status = resolveSidebarV2Status(thread);
    if (status === "approval") hasApproval = true;
    else if (status === "input") hasInput = true;
    else if (status === "failed") hasFailed = true;
    else if (status === "working") {
      hasWorking = true;
      const startedAt = resolveWorkingStartedAt(thread);
      const startedMs = startedAt === null ? Number.NaN : Date.parse(startedAt);
      // Earliest running start wins: the card counts the oldest in-flight
      // work, not the most recently kicked-off member.
      if (!Number.isNaN(startedMs) && startedMs < workingStartedAtMs) {
        workingStartedAt = startedAt;
        workingStartedAtMs = startedMs;
      }
    }
  }
  if (hasApproval) return { kind: "approval", workingStartedAt: null };
  if (hasInput) return { kind: "input", workingStartedAt: null };
  if (hasWorking) return { kind: "working", workingStartedAt };
  if (hasFailed) return { kind: "failed", workingStartedAt: null };
  return null;
}

/** The member whose latest activity stamps the card's resting time label. */
export function pickWorktreeGroupTimeLabelThread(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): EnvironmentThreadShell {
  return threads.reduce((latest, thread) => {
    const latestMs = firstValidTimestampMs(latest.latestUserMessageAt, latest.updatedAt);
    const threadMs = firstValidTimestampMs(thread.latestUserMessageAt, thread.updatedAt);
    return threadMs >= latestMs ? thread : latest;
  });
}
