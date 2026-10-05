import {
  normalizeThreadPullRequestSearchQuery,
  threadPullRequestSearchTerms,
} from "@t3tools/shared/threadPullRequests";
import {
  effectiveSnoozed,
  hasQueuedTurnStart,
  QUEUED_TURN_START_GRACE_MS,
  resolveSnoozePresets,
  snoozeWakeLabel,
} from "@t3tools/client-runtime/state/thread-settled";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import {
  hasUnseenThreadCompletion,
  resolveThreadSemanticStatus,
} from "@t3tools/client-runtime/state/thread-status";
import {
  activeThreadAnchorTimestampMs,
  resolveSettledThreadTimestamp,
  sortPinnedThreadsByOrderKey,
} from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import {
  buildMobileThreadTree,
  compareNestedThreads,
  isRootThread,
  mobileThreadTreeRows,
  resolveNestedThreadStatus,
  selectMatchingThreadTree,
  nestedThreadRevealKeys,
  nestedVirtualAgentKeys,
  nestedVirtualAgentSearchKeys,
  type NestedThreadReadMarkers,
  type MobileThreadTreeRow,
  type MobileThreadShell,
  type NestedThreadStatus,
} from "./mobile-thread-hierarchy";
import { resolveThreadListRowStatus, type ThreadListRowStatus } from "./thread-list-row-status";

export { snoozeWakeLabel };

/**
 * Thread List v2 model, ported from the web project's sidebar logic
 * (apps/web/src/components/Sidebar.logic.ts).
 *
 * Approval, input, work and failure roll up from descendants. Ready is the
 * unlabeled resting state.
 */
export type ThreadListV2Status = NestedThreadStatus | "completed";
export type ThreadListV2SwipeAction = "archive" | "settle" | "unsettle" | "snooze" | "unsnooze";

export function resolveThreadListV2SnoozeMenuSelection(input: {
  readonly event: string;
  readonly displayedPresets: ReadonlyArray<SnoozePreset>;
  readonly now: Date;
}):
  | { readonly _tag: "selected"; readonly preset: SnoozePreset }
  | { readonly _tag: "expired" }
  | { readonly _tag: "not-snooze" } {
  if (!input.event.startsWith("snooze:")) return { _tag: "not-snooze" };

  const currentPreset = resolveSnoozePresets(input.now).find(
    (candidate) => input.event === `snooze:${candidate.id}`,
  );
  if (currentPreset) return { _tag: "selected", preset: currentPreset };

  const displayedPreset = input.displayedPresets.find(
    (candidate) => input.event === `snooze:${candidate.id}`,
  );
  if (displayedPreset && Date.parse(displayedPreset.snoozedUntil) > input.now.getTime()) {
    return { _tag: "selected", preset: displayedPreset };
  }
  return { _tag: "expired" };
}

export function resolveThreadListV2SwipeActions(input: {
  readonly variant: "card" | "slim";
  readonly settlementSupported: boolean;
  readonly snoozeSupported: boolean;
  readonly snoozable: boolean;
  /** Row is on the snoozed shelf. */
  readonly snoozed?: boolean;
}): {
  readonly primary: Exclude<ThreadListV2SwipeAction, "snooze">;
  readonly secondary: "snooze" | null;
} {
  if (input.snoozed === true) {
    return { primary: "unsnooze", secondary: null };
  }
  const primary = input.settlementSupported
    ? input.variant === "slim"
      ? "unsettle"
      : "settle"
    : "archive";
  return {
    primary,
    secondary: input.snoozeSupported && input.snoozable ? "snooze" : null,
  };
}

/**
 * The point at which a queued-turn snooze guard expires on its own. Rows arm
 * a one-shot timer for this boundary so Snooze appears without waiting for an
 * unrelated render. User-blocked threads return null because only fresh
 * server data can make them snoozable.
 */
export function resolveThreadListV2SnoozeGateExpiryMs(
  thread: Pick<
    EnvironmentThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "latestUserMessageAt" | "latestTurn" | "session"
  >,
  options: { readonly now: string },
): number | null {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return null;
  if (!hasQueuedTurnStart(thread, options)) return null;
  const messageAtMs = Date.parse(thread.latestUserMessageAt ?? "");
  if (Number.isNaN(messageAtMs)) return null;
  return messageAtMs + QUEUED_TURN_START_GRACE_MS;
}

// Settled-tail paging: recent history is the common lookup; the deep tail
// stays behind an explicit Show more. Shared by the compact Home list and
// the iPad sidebar so both page identically.
export const THREAD_LIST_V2_SETTLED_INITIAL_COUNT = 10;
export const THREAD_LIST_V2_SETTLED_PAGE_COUNT = 25;

/**
 * Thread List v2 is the default on every app variant; the Settings →
 * Legacy toggle opts a device back into the grouped legacy list. Preferences
 * persist as sparse patches, so `undefined` genuinely means "never chosen".
 *
 * `preferencesLoaded` guards the startup window: preferences load
 * asynchronously, and rendering one list before the stored choice arrives would
 * remount the whole thing a tick later. While loading, hold the default — that
 * is where every device without an explicit legacy opt-in lands anyway.
 */
export function resolveThreadListV2Enabled(input: {
  readonly legacyPreference: boolean | undefined;
  readonly preferencesLoaded: boolean;
}): boolean {
  if (!input.preferencesLoaded) {
    return true;
  }
  return input.legacyPreference !== true;
}

export function resolveThreadListV2Status(
  thread: Parameters<typeof resolveNestedThreadStatus>[0],
  lastVisitedAt?: string | null,
): ThreadListV2Status {
  const status = resolveThreadSemanticStatus({
    hasPendingApprovals: thread.hasPendingApprovals,
    hasPendingUserInput: thread.hasPendingUserInput,
    hasPendingQueuedTurn: thread.hasPendingQueuedTurn,
    latestTurn: thread.latestTurn,
    session: thread.session,
    virtualAgentRun: thread.virtualAgentRun,
    hasUnseenCompletion:
      isRootThread(thread) &&
      hasUnseenThreadCompletion({
        latestTurn: thread.latestTurn,
        lastVisitedAt,
      }),
  });
  return status === "plan-ready" ? "ready" : status;
}

/** NaN-safe Date.parse for sort comparators: a malformed timestamp must not
    poison the whole ordering, so it sinks to the epoch instead. */
function parseTimestampMs(isoDate: string): number {
  const parsed = Date.parse(isoDate);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * v2 sort: static order, newest anchor on top. Activity NEVER reorders the
 * list — a row holds its position between lifecycle transitions. The anchor
 * is creation time until an un-settle re-anchors it (see
 * activeThreadAnchorTimestampMs), so an un-settled thread surfaces at the
 * top instead of sinking back to its creation-order slot. Mirrors web's
 * sortThreadsForSidebar.
 */
export function sortThreadsForListV2<
  T extends {
    readonly id: string;
    readonly createdAt: string;
    readonly unsettledAt?: string | null | undefined;
  },
>(threads: readonly T[]): T[] {
  // .sort() on a copy, not .toSorted(): Hermes doesn't ship the ES2023
  // change-by-copy array methods.
  return [...threads].sort(
    (left, right) =>
      activeThreadAnchorTimestampMs(right) - activeThreadAnchorTimestampMs(left) ||
      left.id.localeCompare(right.id),
  );
}

export interface ThreadListV2Item {
  readonly thread: MobileThreadShell;
  readonly hierarchy?: MobileThreadTreeRow;
  readonly status: Exclude<ThreadListRowStatus, "queued" | "draft">;
  readonly variant: "card" | "slim";
  /** Snoozed-shelf row: shows the wake countdown and offers Wake. */
  readonly snoozed: boolean;
  /** Pinned-block row: renders the pin glyph and offers Unpin. */
  readonly pinned: boolean;
  readonly isLast: boolean;
}

export function resolveThreadListV2RootState(input: {
  readonly thread: MobileThreadShell;
  readonly relatedStatus: NestedThreadStatus;
  readonly hasUnreadDescendant?: boolean;
  readonly settlementSupported: boolean;
  readonly snoozeSupported: boolean;
  readonly now: string;
}): Pick<ThreadListV2Item, "variant" | "snoozed" | "pinned"> {
  const { thread } = input;
  // Unread terminal child activity promotes the root without changing the
  // parent's own execution status or rolling it up as Working.
  if (input.hasUnreadDescendant === true) {
    return { variant: "card", snoozed: false, pinned: thread.pinnedAt != null };
  }
  if (input.relatedStatus === "ready") {
    if (input.snoozeSupported && effectiveSnoozed(thread, { now: input.now })) {
      return { variant: "slim", snoozed: true, pinned: false };
    }
    if (
      input.settlementSupported &&
      thread.settledOverride === "settled" &&
      resolveNestedThreadStatus(thread) === "ready"
    ) {
      return { variant: "slim", snoozed: false, pinned: false };
    }
  }
  return { variant: "card", snoozed: false, pinned: thread.pinnedAt != null };
}

export interface ThreadListV2Layout {
  readonly items: ThreadListV2Item[];
  /** Settled threads beyond the render limit (behind "Show more"). */
  readonly hiddenSettledCount: number;
  /** Snoozed threads matching the current filters. */
  readonly snoozedCount: number;
  /** Index in `items` where the Snoozed shelf header belongs. The header is
      still rendered when the shelf is collapsed and no snoozed rows exist. */
  readonly snoozedShelfHeaderIndex: number | null;
  /** Total settled threads in scope, including rows hidden by collapse/paging. */
  readonly settledCount: number;
  /** Index in `items` where the Settled shelf header belongs. */
  readonly settledShelfHeaderIndex: number | null;
  /** Soonest wake time among snoozed threads, or null. Callers arm
      a timeout at this boundary so the list re-partitions the moment a
      snooze expires instead of on the next minute tick. */
  readonly nextSnoozeWakeAt: string | null;
}

export interface ThreadListV2ThreadListItem {
  readonly type: "v2-thread";
  readonly key: string;
  readonly item: ThreadListV2Item;
  /** Precomputed so recycled-list equality can see a minute-tick change. */
  readonly snoozeWakeLabelText: string | undefined;
}

export interface ThreadListV2PendingListItem {
  readonly type: "v2-pending";
  readonly key: string;
  readonly pendingTask: PendingNewTask;
  /** First queued row after the active block draws the PENDING divider. */
  readonly showPendingDivider: boolean;
}

export interface ThreadListV2SnoozedShelfListItem {
  readonly type: "v2-snoozed-shelf";
  readonly key: "v2-snoozed-shelf";
  readonly count: number;
  readonly expanded: boolean;
}

export interface ThreadListV2SettledShelfListItem {
  readonly type: "v2-settled-shelf";
  readonly key: "v2-settled-shelf";
  readonly count: number;
  readonly expanded: boolean;
}

export type ThreadListV2ListItem =
  | ThreadListV2ThreadListItem
  | ThreadListV2PendingListItem
  | ThreadListV2SnoozedShelfListItem
  | ThreadListV2SettledShelfListItem;

/**
 * Builds the shared mobile order: active → pending → snoozed shelf → settled.
 * Pending tasks are waiting rather than asking, and parked work remains
 * reachable without competing with either the inbox or settled history.
 */
export function buildThreadListV2ListItems(input: {
  readonly items: ReadonlyArray<ThreadListV2Item>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly snoozedCount?: number;
  readonly snoozedShelfExpanded?: boolean;
  readonly snoozedShelfHeaderIndex?: number | null;
  readonly settledCount?: number;
  readonly settledShelfExpanded?: boolean;
  readonly settledShelfHeaderIndex?: number | null;
  readonly snoozeLabelNow?: string;
}): ThreadListV2ListItem[] {
  const threadItems = input.items.map(
    (item): ThreadListV2ListItem => ({
      type: "v2-thread",
      key: `v2-thread:${item.thread.environmentId}:${item.thread.id}`,
      item,
      snoozeWakeLabelText:
        item.snoozed && item.thread.snoozedUntil != null && input.snoozeLabelNow !== undefined
          ? snoozeWakeLabel(item.thread.snoozedUntil, { now: input.snoozeLabelNow })
          : undefined,
    }),
  );
  const pendingItems = input.pendingTasks.map(
    (pendingTask, index): ThreadListV2ListItem => ({
      type: "v2-pending",
      key: `v2-${pendingTask.key}`,
      pendingTask,
      showPendingDivider: index === 0,
    }),
  );
  const snoozedCount = input.snoozedCount ?? 0;
  const snoozedShelfHeaderIndex = input.snoozedShelfHeaderIndex ?? null;
  const settledCount = input.settledCount ?? 0;
  const settledShelfHeaderIndex = input.settledShelfHeaderIndex ?? null;
  const activeEnd = snoozedShelfHeaderIndex ?? settledShelfHeaderIndex ?? threadItems.length;
  const snoozedEnd = settledShelfHeaderIndex ?? threadItems.length;
  const result: ThreadListV2ListItem[] = [...threadItems.slice(0, activeEnd), ...pendingItems];
  if (snoozedShelfHeaderIndex !== null && snoozedCount > 0) {
    result.push({
      type: "v2-snoozed-shelf",
      key: "v2-snoozed-shelf",
      count: snoozedCount,
      expanded: input.snoozedShelfExpanded === true,
    });
    result.push(...threadItems.slice(snoozedShelfHeaderIndex, snoozedEnd));
  }
  if (settledShelfHeaderIndex !== null && settledCount > 0) {
    result.push({
      type: "v2-settled-shelf",
      key: "v2-settled-shelf",
      count: settledCount,
      expanded: input.settledShelfExpanded !== false,
    });
    result.push(...threadItems.slice(settledShelfHeaderIndex));
  }
  return result;
}

/**
 * Recycled-list equality for v2 rows. Every layout rebuild mints fresh
 * item/row objects (even when nothing visible changed), so reference
 * equality would re-render every visible row on each toggle — compare the
 * fields rows actually consume instead. Shared by the Home list and the
 * iPad sidebar so both recycle identically.
 */
export function threadListV2ItemsAreEqual(
  previous: ThreadListV2ListItem,
  item: ThreadListV2ListItem,
): boolean {
  if (previous.type === "v2-thread" && item.type === "v2-thread") {
    return (
      previous.key === item.key &&
      previous.item.thread === item.item.thread &&
      previous.item.hierarchy?.depth === item.item.hierarchy?.depth &&
      previous.item.hierarchy?.isExpanded === item.item.hierarchy?.isExpanded &&
      previous.item.hierarchy?.childCount === item.item.hierarchy?.childCount &&
      previous.item.hierarchy?.relatedChildCount === item.item.hierarchy?.relatedChildCount &&
      previous.item.hierarchy?.displayStatus === item.item.hierarchy?.displayStatus &&
      previous.item.hierarchy?.relatedStatus === item.item.hierarchy?.relatedStatus &&
      previous.item.hierarchy?.archiveBlocked === item.item.hierarchy?.archiveBlocked &&
      previous.item.hierarchy?.latestRelatedNotificationAt ===
        item.item.hierarchy?.latestRelatedNotificationAt &&
      previous.item.status === item.item.status &&
      previous.item.variant === item.item.variant &&
      previous.item.snoozed === item.item.snoozed &&
      previous.item.pinned === item.item.pinned &&
      previous.snoozeWakeLabelText === item.snoozeWakeLabelText
    );
  }
  if (previous.type === "v2-pending" && item.type === "v2-pending") {
    return (
      previous.pendingTask === item.pendingTask &&
      previous.showPendingDivider === item.showPendingDivider
    );
  }
  if (previous.type === "v2-snoozed-shelf" && item.type === "v2-snoozed-shelf") {
    return previous.count === item.count && previous.expanded === item.expanded;
  }
  if (previous.type === "v2-settled-shelf" && item.type === "v2-settled-shelf") {
    return previous.count === item.count && previous.expanded === item.expanded;
  }
  return false;
}

/**
 * Keeps root groups together across shelves. Active roots and children use
 * recent subtree activity; snoozed and settled roots retain their shelf order.
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
  /** Environments whose server supports thread.settle/unsettle. Threads on
      other environments never classify as settled — the user could neither
      un-settle nor pin them. Absent = no gating (tests). */
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  /** Environments whose server supports thread.snooze/unsnooze. Same
      contract as settlementEnvironmentIds. */
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  /** Max settled rows to render; the rest are counted, not built. */
  readonly settledLimit?: number;
  /** Second-precise clock used for time-based classification. */
  readonly now: string;
  /** Expands the snoozed shelf into rows. Collapsed is the default. */
  readonly snoozedShelfExpanded?: boolean;
  /** Expands the settled shelf into rows. Expanded is the default. */
  readonly settledShelfExpanded?: boolean;
  /** The selected thread remains visible on an otherwise collapsed shelf so
      a split-view detail can never lose its navigation row. */
  readonly selectedThreadKey?: string | null;
  readonly dismissedAgentRunKeys?: readonly string[];
  readonly threadChildReadAt?: NestedThreadReadMarkers;
  readonly threadCompletionReadAt?: Readonly<Record<string, string>>;
  /** Thread keys whose inline subchats stay hidden behind the parent
      chevron. Search suspends collapse so matches never hide. */
  readonly collapsedThreadKeys?: ReadonlySet<string>;
}): ThreadListV2Layout {
  const now = input.now;
  const rawQuery = input.searchQuery.trim();
  const query = (normalizeThreadPullRequestSearchQuery(rawQuery) ?? rawQuery).toLocaleLowerCase();
  const projectKeys = input.projectRefs
    ? new Set(input.projectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`))
    : null;

  const pinned: EnvironmentThreadShell[] = [];
  const active: EnvironmentThreadShell[] = [];
  const settled: EnvironmentThreadShell[] = [];
  const snoozed: EnvironmentThreadShell[] = [];
  const scopedThreads = input.threads.filter(
    (thread) =>
      (input.environmentId === null || thread.environmentId === input.environmentId) &&
      (projectKeys === null || projectKeys.has(`${thread.environmentId}:${thread.projectId}`)),
  );
  // Skipped for the common no-query case: nothing downstream reads the
  // set then, and lowercasing every title on each layout is pure waste.
  const matchingKeys =
    query.length === 0
      ? new Set<string>()
      : new Set(
          scopedThreads
            .filter(
              (thread) =>
                thread.title.toLocaleLowerCase().includes(query) ||
                threadPullRequestSearchTerms(thread).some((term) =>
                  term.toLocaleLowerCase().includes(query),
                ) ||
                input.matchedThreadKeys?.has(
                  threadSearchMatchKey({
                    environmentId: thread.environmentId,
                    threadId: thread.id,
                  }),
                ),
            )
            .map((thread) => `${thread.environmentId}:${thread.id}`),
        );
  const tree = buildMobileThreadTree(
    scopedThreads,
    compareNestedThreads,
    input.dismissedAgentRunKeys,
    {
      readMarkers: input.threadChildReadAt,
      includeReadCompletedChildren: query.length > 0,
      selectedThreadKey: input.selectedThreadKey,
    },
  );
  const searchKeys =
    query.length > 0
      ? new Set([...matchingKeys, ...nestedVirtualAgentSearchKeys(tree, query)])
      : matchingKeys;
  const roots = query.length > 0 ? selectMatchingThreadTree(tree, searchKeys) : tree;
  const nodesByKey = new Map(tree.map((node) => [node.threadKey, node]));
  const rowsByRootKey = new Map(
    roots.map((node) => [
      node.threadKey,
      mobileThreadTreeRows([node], {
        selectedThreadKey: input.selectedThreadKey,
        revealThreadKeys:
          query.length > 0
            ? new Set([...searchKeys, ...nestedVirtualAgentKeys([node]).values()])
            : nestedThreadRevealKeys([node], input.threadChildReadAt ?? {}),
        includeAllDescendants: query.length === 0,
        collapsedKeys: query.length === 0 ? input.collapsedThreadKeys : undefined,
      }),
    ]),
  );
  const rootContainsSelection = (thread: EnvironmentThreadShell) =>
    rowsByRootKey
      .get(`${thread.environmentId}:${thread.id}`)
      ?.some((row) => row.threadKey === input.selectedThreadKey) === true;
  let nextSnoozeWakeAt: string | null = null;
  for (const node of roots) {
    const thread = node.thread;
    // Callers pass live shells. The server stamps settledOverride for the tail.
    if (input.environmentId !== null && thread.environmentId !== input.environmentId) continue;
    if (projectKeys !== null && !projectKeys.has(`${thread.environmentId}:${thread.projectId}`)) {
      continue;
    }
    const state = resolveThreadListV2RootState({
      thread,
      relatedStatus: node.relatedStatus ?? "ready",
      hasUnreadDescendant: node.hasUnreadDescendant === true,
      settlementSupported: input.settlementEnvironmentIds?.has(thread.environmentId) ?? true,
      snoozeSupported: input.snoozeEnvironmentIds?.has(thread.environmentId) ?? true,
      now,
    });
    // Snooze outranks settlement and pinning until the thread wakes.
    if (state.snoozed) {
      snoozed.push(thread);
      if (
        thread.snoozedUntil != null &&
        (nextSnoozeWakeAt === null ||
          parseTimestampMs(thread.snoozedUntil) < parseTimestampMs(nextSnoozeWakeAt))
      ) {
        nextSnoozeWakeAt = thread.snoozedUntil;
      }
      continue;
    }
    if (state.variant === "slim") {
      settled.push(thread);
    } else if (state.pinned) {
      pinned.push(thread);
    } else {
      active.push(thread);
    }
  }

  const compareRoots = (left: EnvironmentThreadShell, right: EnvironmentThreadShell) =>
    compareNestedThreads(
      nodesByKey.get(`${left.environmentId}:${left.id}`)?.mostRecentThread ?? left,
      nodesByKey.get(`${right.environmentId}:${right.id}`)?.mostRecentThread ?? right,
    );
  const orderedActive = [...active].sort(compareRoots);
  const orderedSnoozed = [...snoozed].sort(
    (left, right) =>
      parseTimestampMs(left.snoozedUntil ?? "") - parseTimestampMs(right.snoozedUntil ?? ""),
  );
  const visibleSnoozed =
    query.length > 0 || input.snoozedShelfExpanded === true
      ? orderedSnoozed
      : orderedSnoozed.filter(rootContainsSelection);
  const orderedSettled = [...settled].sort(
    (left, right) =>
      parseTimestampMs(resolveSettledThreadTimestamp(right) ?? "") -
      parseTimestampMs(resolveSettledThreadTimestamp(left) ?? ""),
  );
  const settledLimit = input.settledLimit ?? Number.POSITIVE_INFINITY;
  const pagedSettled =
    orderedSettled.length > settledLimit ? orderedSettled.slice(0, settledLimit) : orderedSettled;
  const selectedSettled = orderedSettled.slice(pagedSettled.length).find(rootContainsSelection);
  if (selectedSettled !== undefined) pagedSettled.push(selectedSettled);
  const visibleSettled =
    query.length > 0 || input.settledShelfExpanded !== false
      ? pagedSettled
      : pagedSettled.filter(rootContainsSelection);

  const items: ThreadListV2Item[] = [];
  for (const thread of sortPinnedThreadsByOrderKey(pinned)) {
    items.push({
      thread,
      status: resolveThreadListRowStatus(thread, input.threadCompletionReadAt),
      variant: "card",
      snoozed: false,
      pinned: true,
      isLast: false,
    });
  }
  for (const thread of orderedActive) {
    items.push({
      thread,
      status: resolveThreadListRowStatus(thread, input.threadCompletionReadAt),
      variant: "card",
      snoozed: false,
      pinned: false,
      isLast: false,
    });
  }
  const snoozedShelfHeaderIndex = orderedSnoozed.length > 0 ? items.length : null;
  for (const thread of visibleSnoozed) {
    items.push({
      thread,
      status: resolveThreadListRowStatus(thread, input.threadCompletionReadAt),
      variant: "slim",
      snoozed: true,
      pinned: false,
      isLast: false,
    });
  }
  const settledShelfHeaderIndex = orderedSettled.length > 0 ? items.length : null;
  for (const thread of visibleSettled) {
    items.push({
      thread,
      status: resolveThreadListRowStatus(thread, input.threadCompletionReadAt),
      variant: "slim",
      snoozed: false,
      pinned: false,
      isLast: false,
    });
  }
  const expandedItems: ThreadListV2Item[] = items.flatMap((item) =>
    (rowsByRootKey.get(`${item.thread.environmentId}:${item.thread.id}`) ?? []).map((row) => ({
      ...item,
      thread: row.thread,
      hierarchy: row,
      status: resolveThreadListRowStatus(row.thread, input.threadCompletionReadAt),
      pinned: item.pinned && row.depth === 0,
    })),
  );
  const expandedIndex = (index: number | null) =>
    index === null
      ? null
      : items
          .slice(0, index)
          .reduce(
            (count, item) =>
              count +
              (rowsByRootKey.get(`${item.thread.environmentId}:${item.thread.id}`)?.length ?? 0),
            0,
          );
  const last = expandedItems.at(-1);
  if (last) {
    expandedItems[expandedItems.length - 1] = { ...last, isLast: true };
  }
  return {
    items: expandedItems,
    hiddenSettledCount: orderedSettled.length - pagedSettled.length,
    snoozedCount: orderedSnoozed.length,
    snoozedShelfHeaderIndex: expandedIndex(snoozedShelfHeaderIndex),
    settledCount: orderedSettled.length,
    settledShelfHeaderIndex: expandedIndex(settledShelfHeaderIndex),
    nextSnoozeWakeAt,
  };
}
