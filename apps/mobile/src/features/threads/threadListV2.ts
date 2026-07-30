import { effectiveSettled, effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import type { PendingNewTask } from "../../state/use-pending-new-tasks";

/**
 * Thread List v2 model, ported from the web sidebar v2
 * (apps/web/src/components/Sidebar.logic.ts + SidebarV2.tsx).
 *
 * Four visual states, three colors: color is reserved for "act now"
 * (approval), "in motion" (working), and "broken" (failed). Ready is the
 * unlabeled resting state.
 */
export type ThreadListV2Status = "approval" | "input" | "working" | "failed" | "ready";

// Settled-tail paging: recent history is the common lookup; the deep tail
// stays behind an explicit Show more. Shared by the compact Home list and
// the iPad sidebar so both page identically.
export const THREAD_LIST_V2_SETTLED_INITIAL_COUNT = 10;
export const THREAD_LIST_V2_SETTLED_PAGE_COUNT = 25;

/**
 * Thread List v2 is on by default on every app variant; the Settings → Beta
 * toggle is an opt-out. Preferences persist as sparse patches, so `undefined`
 * genuinely means "never chosen".
 *
 * `preferencesLoaded` guards the startup window: preferences load
 * asynchronously, and rendering one list before the stored choice arrives would
 * remount the whole thing a tick later. While loading, hold the default — that
 * is where every device without an explicit opt-out lands anyway.
 */
export function resolveThreadListV2Enabled(input: {
  readonly preference: boolean | undefined;
  readonly preferencesLoaded: boolean;
}): boolean {
  if (!input.preferencesLoaded) {
    return true;
  }
  return input.preference ?? true;
}

export function resolveThreadListV2Status(
  thread: Pick<EnvironmentThreadShell, "hasPendingApprovals" | "hasPendingUserInput" | "session">,
): ThreadListV2Status {
  if (thread.hasPendingApprovals) {
    return "approval";
  }
  if (thread.hasPendingUserInput) {
    return "input";
  }
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return "working";
  }
  if (thread.session?.status === "error") {
    return "failed";
  }
  return "ready";
}

/** NaN-safe Date.parse for sort comparators: a malformed timestamp must not
    poison the whole ordering, so it sinks to the epoch instead. */
function parseTimestampMs(isoDate: string): number {
  const parsed = Date.parse(isoDate);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** First VALID timestamp wins: a present-yet-malformed string falls through
    to the next candidate rather than sinking the row to the epoch. */
function firstValidTimestampMs(...candidates: ReadonlyArray<string | null | undefined>): number {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

/**
 * v2 sort: static creation order, newest thread on top. Activity NEVER
 * reorders the list — a row holds its position from open until settled, so
 * the screen only moves at lifecycle transitions. Mirrors web's
 * sortThreadsForSidebarV2.
 */
export function sortThreadsForListV2<T extends { readonly id: string; readonly createdAt: string }>(
  threads: readonly T[],
): T[] {
  // .sort() on a copy, not .toSorted(): Hermes doesn't ship the ES2023
  // change-by-copy array methods.
  return [...threads].sort(
    (left, right) =>
      parseTimestampMs(right.createdAt) - parseTimestampMs(left.createdAt) ||
      left.id.localeCompare(right.id),
  );
}

export interface ThreadListV2Item {
  readonly thread: EnvironmentThreadShell;
  readonly variant: "card" | "slim";
  /** First settled row after the card block draws the SETTLED divider. */
  readonly showSettledDivider: boolean;
  readonly isLast: boolean;
}

export interface ThreadListV2Layout {
  readonly items: ThreadListV2Item[];
  /** Settled threads beyond the render limit (behind "Show more"). */
  readonly hiddenSettledCount: number;
  /** Snoozed threads hidden from the list (visibility parity with web's
      collapsed Snoozed shelf; mobile has no shelf UI yet). */
  readonly snoozedCount: number;
  /** Soonest wake time among hidden snoozed threads, or null. Callers arm
      a timeout at this boundary so the list re-partitions the moment a
      snooze expires instead of on the next minute tick. */
  readonly nextSnoozeWakeAt: string | null;
}

export interface ThreadListV2ThreadListItem {
  readonly type: "v2-thread";
  readonly key: string;
  readonly item: ThreadListV2Item;
}

export interface ThreadListV2PendingListItem {
  readonly type: "v2-pending";
  readonly key: string;
  readonly pendingTask: PendingNewTask;
  /** First queued row after the active block draws the PENDING divider. */
  readonly showPendingDivider: boolean;
}

export type ThreadListV2ListItem = ThreadListV2ThreadListItem | ThreadListV2PendingListItem;

/**
 * Splices queued tasks between the active block and the settled tail, so the
 * list reads active → pending → settled. Queued work sits below the live
 * threads because nothing can happen to it until its environment returns:
 * it is waiting, not asking. Shared by the compact Home list and the iPad
 * sidebar so both order and label the sections identically.
 */
export function buildThreadListV2ListItems(input: {
  readonly items: ReadonlyArray<ThreadListV2Item>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
}): ThreadListV2ListItem[] {
  const threadItems = input.items.map(
    (item): ThreadListV2ListItem => ({
      type: "v2-thread",
      key: `v2-thread:${item.thread.environmentId}:${item.thread.id}`,
      item,
    }),
  );
  if (input.pendingTasks.length === 0) return threadItems;

  const pendingItems = input.pendingTasks.map(
    (pendingTask, index): ThreadListV2ListItem => ({
      type: "v2-pending",
      key: `v2-pending:${pendingTask.message.messageId}`,
      pendingTask,
      showPendingDivider: index === 0,
    }),
  );
  // The settled tail begins at the row that draws the SETTLED divider; with
  // no settled rows the queued block simply ends the list.
  const settledStart = threadItems.findIndex(
    (entry) => entry.type === "v2-thread" && entry.item.showSettledDivider,
  );
  return settledStart === -1
    ? [...threadItems, ...pendingItems]
    : [...threadItems.slice(0, settledStart), ...pendingItems, ...threadItems.slice(settledStart)];
}

/**
 * Partitions visible threads into the active card block (creation order) and
 * the settled recency tail, matching the web v2 list. `autoSettleAfterDays`
 * mirrors the web default of 3 — mobile has no client-settings sync yet, so
 * the default is fixed here rather than user-configurable.
 */
export function buildThreadListV2Items(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs?: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }> | null;
  readonly searchQuery: string;
  readonly matchedThreadKeys?: ReadonlySet<string>;
  /** Per-row PR state reported up by visible rows ("env:threadId" keys). */
  readonly changeRequestStateByKey?: ReadonlyMap<string, "open" | "closed" | "merged">;
  /** Environments whose server supports thread.settle/unsettle. Threads on
      other environments never classify as settled — the user could neither
      un-settle nor pin them. Absent = no gating (tests). */
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  /** Environments whose server supports thread.snooze/unsnooze. Same
      contract as settlementEnvironmentIds. */
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly autoSettleAfterDays?: number;
  /** Max settled rows to render; the rest are counted, not built. */
  readonly settledLimit?: number;
  /** Injectable for tests; defaults to now. */
  readonly now?: string;
  /** Second-precise clock for snooze classification. Callers pass a
      minute-quantized `now` for memoization; snooze wake times are
      second-precise, so classifying with the floored minute would hold a
      woken thread hidden for up to a minute. Defaults to `now`. */
  readonly snoozeNow?: string;
}): ThreadListV2Layout {
  const now = input.now ?? new Date().toISOString();
  const snoozeNow = input.snoozeNow ?? now;
  const autoSettleAfterDays = input.autoSettleAfterDays ?? 3;
  const query = input.searchQuery.trim().toLocaleLowerCase();
  const projectKeys = input.projectRefs
    ? new Set(input.projectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`))
    : null;

  const active: EnvironmentThreadShell[] = [];
  const settled: EnvironmentThreadShell[] = [];
  let snoozedCount = 0;
  let nextSnoozeWakeAt: string | null = null;
  for (const thread of input.threads) {
    // Callers pass live (unarchived) shells; settled threads are among them
    // and partition into the tail via effectiveSettled.
    if (input.environmentId !== null && thread.environmentId !== input.environmentId) continue;
    if (projectKeys !== null && !projectKeys.has(`${thread.environmentId}:${thread.projectId}`)) {
      continue;
    }
    if (
      query.length > 0 &&
      !thread.title.toLocaleLowerCase().includes(query) &&
      input.matchedThreadKeys?.has(
        threadSearchMatchKey({
          environmentId: thread.environmentId,
          threadId: thread.id,
        }),
      ) !== true
    ) {
      continue;
    }
    const supportsSettlement = input.settlementEnvironmentIds?.has(thread.environmentId) ?? true;
    const supportsSnooze = input.snoozeEnvironmentIds?.has(thread.environmentId) ?? true;
    const changeRequestState =
      input.changeRequestStateByKey?.get(`${thread.environmentId}:${thread.id}`) ?? null;
    // Visibility parity with web: a snoozed thread leaves the list until it
    // wakes (or raises its hand — effectiveSnoozed refuses blocked/failed
    // work). Snooze outranks settled classification, same as web.
    if (supportsSnooze && effectiveSnoozed(thread, { now: snoozeNow })) {
      snoozedCount += 1;
      if (
        thread.snoozedUntil != null &&
        (nextSnoozeWakeAt === null ||
          parseTimestampMs(thread.snoozedUntil) < parseTimestampMs(nextSnoozeWakeAt))
      ) {
        nextSnoozeWakeAt = thread.snoozedUntil;
      }
      continue;
    }
    if (
      supportsSettlement &&
      effectiveSettled(thread, { now, autoSettleAfterDays, changeRequestState })
    ) {
      settled.push(thread);
    } else {
      active.push(thread);
    }
  }

  const orderedActive = sortThreadsForListV2(active);
  const orderedSettled = [...settled].sort(
    (left, right) =>
      firstValidTimestampMs(right.latestUserMessageAt, right.updatedAt) -
      firstValidTimestampMs(left.latestUserMessageAt, left.updatedAt),
  );
  const settledLimit = input.settledLimit ?? Number.POSITIVE_INFINITY;
  const visibleSettled =
    orderedSettled.length > settledLimit ? orderedSettled.slice(0, settledLimit) : orderedSettled;

  const items: ThreadListV2Item[] = [];
  for (const thread of orderedActive) {
    items.push({ thread, variant: "card", showSettledDivider: false, isLast: false });
  }
  for (const [index, thread] of visibleSettled.entries()) {
    items.push({
      thread,
      variant: "slim",
      showSettledDivider: index === 0,
      isLast: false,
    });
  }
  const last = items.at(-1);
  if (last) {
    items[items.length - 1] = { ...last, isLast: true };
  }
  return {
    items,
    hiddenSettledCount: orderedSettled.length - visibleSettled.length,
    snoozedCount,
    nextSnoozeWakeAt,
  };
}
