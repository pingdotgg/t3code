import { threadPullRequestSearchTerms } from "@t3tools/shared/threadPullRequests";
import {
  canSnooze,
  effectiveSnoozed,
  hasQueuedTurnStart,
  QUEUED_TURN_START_GRACE_MS,
  resolveSnoozePresets,
  snoozeWakeLabel,
} from "@t3tools/client-runtime/state/thread-settled";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveThreadProviderStack } from "@t3tools/client-runtime/state/models";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import {
  matchesThreadSearchFilters,
  getThreadSearchProjectNames,
  parseThreadSearchQuery,
  sortThreadsByActivity,
  type ParsedThreadSearchQuery,
  type ThreadSearchFilters,
  type ThreadSearchMatchContext,
} from "@t3tools/client-runtime/state/threadSearchQuery";
import {
  createInboxReturnTracker,
  isThreadWorking,
  sortInboxThreadsByReturn,
  sortWorkingThreadsBySend,
} from "@t3tools/client-runtime/state/thread-inbox";
import {
  sortActiveThreadsByOrderKey,
  resolveSettledThreadTimestamp,
  sortPinnedThreadsByOrderKey,
  sortSettledThreads,
} from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useMemo } from "react";

import type { ThreadListProvider } from "../../state/thread-list-environments";
import type { ThreadMoveAvailability } from "./threadOrder";

import { relativeTime } from "../../lib/time";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";

import {
  applyPendingThreadOrder,
  reconcilePendingThreadOrder,
  type PendingThreadOrder,
} from "./threadOrder";

export { snoozeWakeLabel };

/** Working section beta: when this device saw each thread leave the Working
    shelf. One instance for Home and the iPad sidebar, so both lists order the
    inbox the same way and the order survives screens that unmount. */
export const threadListInboxReturns = createInboxReturnTracker();

/**
 * Provider drivers for a row's trailing icon stack, back to front. Instances
 * missing from the environment's config are skipped, and an unresolved
 * current provider yields nothing so the row never draws a stale stack.
 */
export function resolveThreadListV2ProviderDrivers(
  thread: Pick<EnvironmentThreadShell, "providerInstanceHistory" | "modelSelection" | "runtime">,
  providers: ReadonlyArray<ThreadListProvider> | undefined,
): ReadonlyArray<string> {
  if (providers === undefined) return [];
  const stack = resolveThreadProviderStack(thread);
  const drivers = stack.flatMap((instanceId) => {
    const driver = providers.find((provider) => provider.instanceId === instanceId)?.driver;
    return driver === undefined ? [] : [driver];
  });
  const currentDriver = providers.find(
    (provider) => provider.instanceId === stack[stack.length - 1],
  )?.driver;
  return currentDriver === undefined ? [] : drivers;
}

/**
 * Thread List v2 model, ported from the web sidebar v2
 * (apps/web/src/components/Sidebar.logic.ts + SidebarV2.tsx).
 *
 * Six visual states. Color distinguishes approval, input, active work, and
 * failures. Ready is the unlabeled resting state; waiting (runtime status "idle") is the agent
 * parked on open background tasks, grey like working rather than a false Done.
 * The orchestrator v2 presentation bridge parks runtime at idle when the
 * post-settlement background roster holds the run's completion (subagents,
 * monitors); commands left running, such as a dev server, read as ready.
 */
export type ThreadListV2Status =
  | "approval"
  | "input"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

export function getMobileThreadSearchEnvironmentNames(input: {
  readonly environmentId: EnvironmentId;
  readonly workspaceLabel?: string;
  readonly savedConnectionLabel?: string;
}): ReadonlyArray<string> {
  const labels = [input.workspaceLabel, input.savedConnectionLabel].filter(
    (name): name is string => name !== undefined && name.length > 0,
  );
  return labels.length > 0 ? [...new Set(labels)] : [input.environmentId];
}

export function createMobileThreadSearchContext(input: {
  readonly projects: ReadonlyMap<
    string,
    { readonly title: string; readonly workspaceRoot: string }
  >;
  readonly environmentNames: (thread: EnvironmentThreadShell) => ReadonlyArray<string>;
  readonly providers: ReadonlyMap<EnvironmentId, ReadonlyArray<ThreadListProvider>>;
}): ThreadSearchMatchContext<EnvironmentThreadShell> {
  return {
    projectNames: (thread) => {
      const project = input.projects.get(`${thread.environmentId}:${thread.projectId}`);
      return getThreadSearchProjectNames(project);
    },
    environmentNames: input.environmentNames,
    providerNames: (thread) => {
      const providers = input.providers.get(thread.environmentId) ?? [];
      return resolveThreadProviderStack(thread).flatMap((instanceId) => {
        const provider = providers.find((entry) => entry.instanceId === instanceId);
        return provider ? [provider.driver, instanceId, provider.displayName ?? ""] : [instanceId];
      });
    },
    statusNames: (thread) => [resolveThreadListV2Status(thread)],
    activityAt: (thread) => thread.latestUserMessageAt ?? thread.updatedAt,
  };
}

export function useMobileThreadSearchContext(input: {
  readonly projects: ReadonlyMap<
    string,
    { readonly title: string; readonly workspaceRoot: string }
  >;
  readonly providers: ReadonlyMap<EnvironmentId, ReadonlyArray<ThreadListProvider>>;
  readonly environmentNames: ReadonlyMap<EnvironmentId, ReadonlyArray<string>>;
}): ThreadSearchMatchContext<EnvironmentThreadShell> {
  return useMemo(
    () =>
      createMobileThreadSearchContext({
        projects: input.projects,
        providers: input.providers,
        environmentNames: (thread) =>
          input.environmentNames.get(thread.environmentId) ?? [thread.environmentId],
      }),
    [input.environmentNames, input.projects, input.providers],
  );
}

export { sortThreadsByActivity };
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
    "hasPendingApprovals" | "hasPendingUserInput" | "latestRun" | "latestUserMessageAt" | "runtime"
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
 * Completed-but-not-yet-seen, mirroring the web sidebar's
 * hasUnseenCompletion. The visited watermark is server state
 * (thread.lastVisitedAt), so the marker agrees across web and mobile.
 * Never-visited threads count as read — a fresh environment must not light
 * up its whole history — and pre-tracking servers (field absent) never
 * report unread.
 */
export function threadHasUnseenCompletion(
  thread: Pick<EnvironmentThreadShell, "latestRun" | "lastVisitedAt">,
): boolean {
  const completedAt = thread.latestRun?.completedAt;
  if (!completedAt) return false;
  const completedAtMs = Date.parse(completedAt);
  if (Number.isNaN(completedAtMs)) return false;
  if (!thread.lastVisitedAt) return false;
  const lastVisitedAtMs = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAtMs)) return true;
  return completedAtMs > lastVisitedAtMs;
}

export function resolveThreadListV2Status(
  thread: Pick<EnvironmentThreadShell, "hasPendingApprovals" | "hasPendingUserInput" | "runtime">,
): ThreadListV2Status {
  if (thread.hasPendingApprovals) {
    return "approval";
  }
  if (thread.hasPendingUserInput) {
    return "input";
  }
  if (
    thread.runtime !== null &&
    ["preparing", "queued", "starting", "running", "waiting"].includes(thread.runtime.status)
  ) {
    return "working";
  }
  if (thread.runtime?.status === "idle") {
    return "waiting";
  }
  if (thread.runtime?.status === "failed") {
    return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  return "ready";
}

/** NaN-safe Date.parse for sort comparators: a malformed timestamp must not
    poison the whole ordering, so it sinks to the epoch instead. */
function parseTimestampMs(isoDate: string): number {
  const parsed = Date.parse(isoDate);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** The active order shared by web and native: new/reopened rows, then the
    saved arrangement. Activity does not move a thread. */
export function sortThreadsForListV2<
  T extends {
    readonly id: string;
    readonly createdAt: string;
    readonly unsettledAt?: string | null | undefined;
    readonly activeOrderKey?: string | null | undefined;
    readonly environmentId?: string | undefined;
  },
>(threads: readonly T[]): T[] {
  return sortActiveThreadsByOrderKey(threads);
}

/** Canonical card section for Move up/down, independent of search or scope. */
export function getThreadListV2OrderedSection(input: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly section: "pinned" | "active";
  readonly pendingOrder?: PendingThreadOrder | null;
  readonly now: string;
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys?: ReadonlySet<string>;
}): EnvironmentThreadShell[] {
  const threads = input.threads.filter((thread) => {
    if (thread.archivedAt !== null || thread.lineage.relationshipToParent === "subagent")
      return false;
    if (
      (input.settlementEnvironmentIds?.has(thread.environmentId) ?? true) &&
      thread.settledOverride === "settled" &&
      input.queuedThreadKeys?.has(`${thread.environmentId}:${thread.id}`) !== true
    ) {
      return false;
    }
    if (
      (input.snoozeEnvironmentIds?.has(thread.environmentId) ?? true) &&
      effectiveSnoozed(thread, { now: input.now })
    ) {
      return false;
    }
    return (thread.pinnedAt != null) === (input.section === "pinned");
  });
  const ordered =
    input.section === "pinned"
      ? sortPinnedThreadsByOrderKey(threads)
      : sortActiveThreadsByOrderKey(threads);
  const pending =
    input.pendingOrder?.section === input.section
      ? reconcilePendingThreadOrder(input.pendingOrder, ordered)
      : null;
  return applyPendingThreadOrder(ordered, input.section, pending);
}

export interface ThreadListV2Item {
  readonly thread: EnvironmentThreadShell;
  readonly variant: "card" | "slim";
  /** Snoozed-shelf row: shows the wake countdown and offers Wake. */
  readonly snoozed: boolean;
  /** Pinned-block row: renders the pin glyph and offers Unpin. */
  readonly pinned: boolean;
  readonly readOnly: boolean;
  readonly isLast: boolean;
}

export interface ThreadListV2Layout {
  readonly items: ThreadListV2Item[];
  /** Settled threads beyond the render limit (behind "Show more"). */
  readonly hiddenSettledCount: number;
  /** Working threads folded away by the Working section beta. */
  readonly workingCount: number;
  /** Index in `items` where the Working shelf header belongs. */
  readonly workingShelfHeaderIndex: number | null;
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
  /** Row timestamp precomputed against the parent clock so the recycler's
      equality only sees a change on rows that actually draw a time. Blank
      while the row renders a status label or the wake countdown instead. */
  readonly timeLabel: string;
  /** Minute clock feeding the row's native snooze menu, carried only on rows
      whose menu holds snooze presets (capability-gated cards the user may
      snooze). Keeping it out of the list's `extraData` means the minute tick
      re-renders just these rows instead of every visible one. */
  readonly snoozePresetMinute: string | undefined;
  /** Inset hairline drawn under the row. Precomputed from the final order so
      a neighbour change (e.g. the queued block appearing) updates the row
      through recycled-list equality instead of leaving a stale divider. */
  readonly showTrailingDivider: boolean;
  /** A message for this thread is waiting in the outbox. Carried on the item
      so an outbox write (which never touches the thread shell) reaches the
      row through recycled-list equality instead of leaving a stale icon. */
  readonly hasQueuedMessages: boolean;
  /** Move up/down availability in the row's card section. Carried on the item
      for the same reason: a reorder in flight (or its commit) changes menu
      availability without changing any shell. */
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
}

export interface ThreadListV2PendingListItem {
  readonly type: "v2-pending";
  readonly key: string;
  readonly pendingTask: PendingNewTask;
  /** First queued row after the active block draws the PENDING divider. */
  readonly showPendingDivider: boolean;
  /** Same rule as the thread rows: a hairline unless the next row carries its
      own section rule or none follows. */
  readonly showTrailingDivider: boolean;
}

export interface ThreadListV2WorkingShelfListItem {
  readonly type: "v2-working-shelf";
  readonly key: "v2-working-shelf";
  readonly count: number;
  readonly expanded: boolean;
  /** See the snoozed shelf header's field. */
  readonly disabled: boolean;
}

export interface ThreadListV2SnoozedShelfListItem {
  readonly type: "v2-snoozed-shelf";
  readonly key: "v2-snoozed-shelf";
  readonly count: number;
  readonly expanded: boolean;
  /** Shelf preferences still loading: the toggle is disabled until they
      arrive. Carried on the item because a recycled cell ignores the render
      closure — without it the header would stay visibly disabled (or enabled
      too early) after the preference load lands. */
  readonly disabled: boolean;
}

export interface ThreadListV2SettledShelfListItem {
  readonly type: "v2-settled-shelf";
  readonly key: "v2-settled-shelf";
  readonly count: number;
  readonly expanded: boolean;
  /** See the snoozed shelf header's field. */
  readonly disabled: boolean;
}

export type ThreadListV2ListItem =
  | ThreadListV2ThreadListItem
  | ThreadListV2PendingListItem
  | ThreadListV2WorkingShelfListItem
  | ThreadListV2SnoozedShelfListItem
  | ThreadListV2SettledShelfListItem;

/** Narrows a wider list-item union (e.g. the sidebar's legacy + v2 mix) to
    the v2 item kinds the shared equality understands. */
export function isThreadListV2ListItem(value: {
  readonly type: string;
}): value is ThreadListV2ListItem {
  return (
    value.type === "v2-thread" ||
    value.type === "v2-pending" ||
    value.type === "v2-working-shelf" ||
    value.type === "v2-snoozed-shelf" ||
    value.type === "v2-settled-shelf"
  );
}

/** Recycled-list equality for the flat v2 list (Home + iPad sidebar).
    Item objects are rebuilt on every minute tick and every partition run;
    without this the lists would consider every mounted row changed and
    re-render all of them (each carrying a swipeable + a PR subscription).
    The clock-derived fields are per-row precomputed text, so a minute tick
    only flips equality on rows whose visible text (or snooze menu) actually
    moved. Thread references are stable across rebuilds. */
export function threadListV2ListItemsAreEqual(
  previous: ThreadListV2ListItem,
  item: ThreadListV2ListItem,
): boolean {
  switch (item.type) {
    case "v2-thread":
      return (
        previous.type === "v2-thread" &&
        previous.key === item.key &&
        previous.item.thread === item.item.thread &&
        previous.item.variant === item.item.variant &&
        previous.item.snoozed === item.item.snoozed &&
        previous.item.pinned === item.item.pinned &&
        previous.snoozeWakeLabelText === item.snoozeWakeLabelText &&
        previous.timeLabel === item.timeLabel &&
        previous.snoozePresetMinute === item.snoozePresetMinute &&
        previous.showTrailingDivider === item.showTrailingDivider &&
        previous.hasQueuedMessages === item.hasQueuedMessages &&
        previous.canMoveUp === item.canMoveUp &&
        previous.canMoveDown === item.canMoveDown
      );
    case "v2-pending":
      return (
        previous.type === "v2-pending" &&
        previous.key === item.key &&
        previous.pendingTask === item.pendingTask &&
        previous.showPendingDivider === item.showPendingDivider &&
        previous.showTrailingDivider === item.showTrailingDivider
      );
    case "v2-working-shelf":
      return (
        previous.type === "v2-working-shelf" &&
        previous.count === item.count &&
        previous.expanded === item.expanded &&
        previous.disabled === item.disabled
      );
    case "v2-snoozed-shelf":
      return (
        previous.type === "v2-snoozed-shelf" &&
        previous.count === item.count &&
        previous.expanded === item.expanded &&
        previous.disabled === item.disabled
      );
    case "v2-settled-shelf":
      return (
        previous.type === "v2-settled-shelf" &&
        previous.count === item.count &&
        previous.expanded === item.expanded &&
        previous.disabled === item.disabled
      );
  }
}

/** The timestamp a row renders when it shows no status label: the settle
    stamp on settled slim rows, otherwise the latest activity. Blank for
    status-labelled cards and snoozed rows with a wake countdown — those
    never draw a time, so their minute tick must not invalidate the cell. */
function resolveThreadListV2ItemTimeLabel(
  item: ThreadListV2Item,
  showSnoozeWakeLabel: boolean,
): string {
  const { thread, variant, snoozed } = item;
  if (showSnoozeWakeLabel) return "";
  if (
    variant === "card" &&
    (resolveThreadListV2Status(thread) !== "ready" || threadHasUnseenCompletion(thread))
  )
    return "";
  const settledTimestamp =
    variant === "slim" && !snoozed ? resolveSettledThreadTimestamp(thread) : null;
  return relativeTime(
    settledTimestamp ?? thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
  );
}

/**
 * Builds the shared mobile order: active → pending → working shelf (beta) →
 * snoozed shelf → settled. Pending tasks are waiting rather than asking, and
 * busy or parked work remains reachable without competing with either the
 * inbox or settled history.
 */
export function buildThreadListV2ListItems(input: {
  readonly items: ReadonlyArray<ThreadListV2Item>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly workingCount?: number;
  readonly workingShelfExpanded?: boolean;
  readonly workingShelfHeaderIndex?: number | null;
  readonly snoozedCount?: number;
  readonly snoozedShelfExpanded?: boolean;
  readonly snoozedShelfHeaderIndex?: number | null;
  readonly settledCount?: number;
  readonly settledShelfExpanded?: boolean;
  readonly settledShelfHeaderIndex?: number | null;
  readonly snoozeLabelNow?: string;
  /** Environments whose server supports thread.snooze. Rows on other
      environments never carry the minute clock that feeds the snooze menu.
      Absent = no gating (tests). */
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  /** Thread keys (`environmentId:threadId`) with a message waiting in the
      outbox; stamped onto the matching rows as `hasQueuedMessages`. */
  readonly queuedThreadKeys?: ReadonlySet<string>;
  /** Menu availability for Move up/down, keyed by `environmentId:threadId`
      (only consulted for card rows — slim menus omit the moves). Produced by
      `computeThreadMoveAvailability` in one pass per section; a recycled cell
      ignores the render closure, so the stamps ride on the item. Absent =
      never available (tests). */
  readonly moveAvailability?: ReadonlyMap<string, ThreadMoveAvailability>;
  /** True while the shelf expansion preferences are still loading; stamped
      onto both shelf headers so the disabled state reaches recycled cells. */
  readonly shelfPreferencesLoading?: boolean;
}): ThreadListV2ListItem[] {
  const threadItems = input.items.map((item): ThreadListV2ListItem => {
    const snoozeWakeLabelText =
      item.snoozed && item.thread.snoozedUntil != null && input.snoozeLabelNow !== undefined
        ? snoozeWakeLabel(item.thread.snoozedUntil, { now: input.snoozeLabelNow })
        : undefined;
    // The minute clock belongs on the item, not the list's extraData, so the
    // recycler's equality can confine the per-minute re-render to rows whose
    // snooze menu actually shows preset times. The swipe-revealed snooze menu
    // exists on slim rows too (the variant only swaps the primary action),
    // so the gate follows actual snooze availability, not the variant.
    const snoozePresetMinute =
      !item.snoozed &&
      input.snoozeLabelNow !== undefined &&
      (input.snoozeEnvironmentIds?.has(item.thread.environmentId) ?? true) &&
      canSnooze(item.thread, { now: input.snoozeLabelNow })
        ? input.snoozeLabelNow
        : undefined;
    const move =
      item.variant === "card"
        ? input.moveAvailability?.get(`${item.thread.environmentId}:${item.thread.id}`)
        : undefined;
    return {
      type: "v2-thread",
      key: `v2-thread:${item.thread.environmentId}:${item.thread.id}`,
      item,
      snoozeWakeLabelText,
      timeLabel: resolveThreadListV2ItemTimeLabel(item, snoozeWakeLabelText !== undefined),
      snoozePresetMinute,
      showTrailingDivider: false,
      hasQueuedMessages:
        input.queuedThreadKeys?.has(`${item.thread.environmentId}:${item.thread.id}`) === true,
      canMoveUp: move?.canMoveUp === true,
      canMoveDown: move?.canMoveDown === true,
    };
  });
  const pendingItems = input.pendingTasks.map((pendingTask, index): ThreadListV2ListItem => ({
    type: "v2-pending",
    key: `v2-${pendingTask.key}`,
    pendingTask,
    showPendingDivider: index === 0,
    showTrailingDivider: false,
  }));
  const workingCount = input.workingCount ?? 0;
  const workingShelfHeaderIndex = input.workingShelfHeaderIndex ?? null;
  const snoozedCount = input.snoozedCount ?? 0;
  const snoozedShelfHeaderIndex = input.snoozedShelfHeaderIndex ?? null;
  const settledCount = input.settledCount ?? 0;
  const settledShelfHeaderIndex = input.settledShelfHeaderIndex ?? null;
  const snoozedEnd = settledShelfHeaderIndex ?? threadItems.length;
  const workingEnd = snoozedShelfHeaderIndex ?? snoozedEnd;
  const activeEnd = workingShelfHeaderIndex ?? workingEnd;
  const result: ThreadListV2ListItem[] = [...threadItems.slice(0, activeEnd), ...pendingItems];
  const shelfDisabled = input.shelfPreferencesLoading === true;
  if (workingShelfHeaderIndex !== null && workingCount > 0) {
    result.push({
      type: "v2-working-shelf",
      key: "v2-working-shelf",
      count: workingCount,
      expanded: input.workingShelfExpanded === true,
      disabled: shelfDisabled,
    });
    result.push(...threadItems.slice(workingShelfHeaderIndex, workingEnd));
  }
  if (snoozedShelfHeaderIndex !== null && snoozedCount > 0) {
    result.push({
      type: "v2-snoozed-shelf",
      key: "v2-snoozed-shelf",
      count: snoozedCount,
      expanded: input.snoozedShelfExpanded === true,
      disabled: shelfDisabled,
    });
    result.push(...threadItems.slice(snoozedShelfHeaderIndex, snoozedEnd));
  }
  if (settledShelfHeaderIndex !== null && settledCount > 0) {
    result.push({
      type: "v2-settled-shelf",
      key: "v2-settled-shelf",
      count: settledCount,
      expanded: input.settledShelfExpanded !== false,
      disabled: shelfDisabled,
    });
    result.push(...threadItems.slice(settledShelfHeaderIndex));
  }
  // Hairlines depend on the final neighbour, so they are stamped after the
  // splice: a recycled cell only re-renders when its divider actually flips.
  return result.map((entry, index) => {
    if (entry.type !== "v2-thread" && entry.type !== "v2-pending") return entry;
    const next = result[index + 1];
    const showTrailingDivider =
      next?.type === "v2-thread" || (next?.type === "v2-pending" && !next.showPendingDivider);
    return showTrailingDivider === entry.showTrailingDivider
      ? entry
      : { ...entry, showTrailingDivider };
  });
}

/**
 * Partitions visible threads into the active card block (saved order) and
 * the settled recency tail, matching the web v2 list.
 */
export function buildThreadListV2Items(input: {
  readonly pendingOrder?: PendingThreadOrder | null;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs?: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }> | null;
  readonly searchQuery?: string;
  readonly parsedSearch?: ParsedThreadSearchQuery;
  readonly searchFilters?: ThreadSearchFilters;
  readonly searchFilterContext?: ThreadSearchMatchContext<EnvironmentThreadShell>;
  readonly searchNow?: Date;
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
  /** Working section beta: unpinned working threads fold into the Working
      shelf, and the inbox orders by when each thread came back to the user
      instead of the saved arrangement. */
  readonly workingShelfEnabled?: boolean;
  /** Expands the Working shelf into rows. Collapsed is the default. */
  readonly workingShelfExpanded?: boolean;
  /** Returns this device observed but the server does not stamp, such as an
      approval request mid-turn. Only read while the beta is on. */
  readonly inboxReturnAt?: (thread: EnvironmentThreadShell) => number | undefined;
  /** Expands the snoozed shelf into rows. Collapsed is the default. */
  readonly snoozedShelfExpanded?: boolean;
  /** Expands the settled shelf into rows. Expanded is the default. */
  readonly settledShelfExpanded?: boolean;
  /** The selected thread remains visible on an otherwise collapsed shelf so
      a split-view detail can never lose its navigation row. */
  readonly selectedThreadKey?: string | null;
  /** Thread keys (`environmentId:threadId`) with a message waiting in the
      outbox. Such a thread has work the user is waiting on, so it stays in
      the active block even when the server has settled it. */
  readonly queuedThreadKeys?: ReadonlySet<string>;
}): ThreadListV2Layout {
  const now = input.now;
  const pending =
    input.pendingOrder == null
      ? null
      : reconcilePendingThreadOrder(
          input.pendingOrder,
          getThreadListV2OrderedSection({
            ...input,
            section: input.pendingOrder.section,
            pendingOrder: null,
          }),
        );
  const parsedSearch =
    input.parsedSearch ??
    (input.searchFilters
      ? {
          text: input.searchQuery ?? "",
          filters: input.searchFilters,
          hasFilters: Object.values(input.searchFilters).some((clauses) =>
            Array.isArray(clauses) ? clauses.length > 0 : clauses,
          ),
        }
      : parseThreadSearchQuery(input.searchQuery ?? "", { now: input.searchNow ?? new Date() }));
  const query = parsedSearch.text.trim().toLocaleLowerCase();
  const projectKeys = input.projectRefs
    ? new Set(input.projectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`))
    : null;

  const workingShelfEnabled = input.workingShelfEnabled === true;
  const pinned: EnvironmentThreadShell[] = [];
  const active: EnvironmentThreadShell[] = [];
  const working: EnvironmentThreadShell[] = [];
  const settled: EnvironmentThreadShell[] = [];
  const snoozed: EnvironmentThreadShell[] = [];
  let nextSnoozeWakeAt: string | null = null;
  for (const thread of input.threads) {
    if (
      (!parsedSearch.filters.archived && thread.archivedAt !== null) ||
      thread.lineage.relationshipToParent === "subagent"
    )
      continue;
    // The server stamps settledOverride for the tail.
    if (input.environmentId !== null && thread.environmentId !== input.environmentId) continue;
    if (projectKeys !== null && !projectKeys.has(`${thread.environmentId}:${thread.projectId}`)) {
      continue;
    }
    if (
      parsedSearch.hasFilters &&
      input.searchFilterContext !== undefined &&
      !matchesThreadSearchFilters(thread, parsedSearch.filters, input.searchFilterContext, {
        now: input.searchNow ?? new Date(),
      })
    )
      continue;
    if (
      query.length > 0 &&
      !thread.title.toLocaleLowerCase().includes(query) &&
      !threadPullRequestSearchTerms(thread).some((term) =>
        term.toLocaleLowerCase().includes(query),
      ) &&
      input.matchedThreadKeys?.has(
        threadSearchMatchKey({
          environmentId: thread.environmentId,
          threadId: thread.id,
        }),
      ) !== true
    ) {
      continue;
    }
    if (parsedSearch.filters.archived) {
      active.push(thread);
      continue;
    }
    const supportsSettlement = input.settlementEnvironmentIds?.has(thread.environmentId) ?? true;
    const supportsSnooze = input.snoozeEnvironmentIds?.has(thread.environmentId) ?? true;
    // Snooze outranks settlement and pinning until the thread wakes.
    if (supportsSnooze && effectiveSnoozed(thread, { now })) {
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
    const hasQueuedMessages =
      input.queuedThreadKeys?.has(`${thread.environmentId}:${thread.id}`) === true;
    if (supportsSettlement && thread.settledOverride === "settled" && !hasQueuedMessages) {
      settled.push(thread);
    } else if (thread.pinnedAt != null) {
      pinned.push(thread);
    } else if (workingShelfEnabled && isThreadWorking(thread)) {
      working.push(thread);
    } else {
      active.push(thread);
    }
  }

  // The beta inbox is time-ordered, so the saved arrangement (and any move in
  // flight) is kept but not applied until the beta is off again.
  const orderedActive = parsedSearch.filters.archived
    ? sortThreadsByActivity(active)
    : workingShelfEnabled
      ? sortInboxThreadsByReturn(active, input.inboxReturnAt)
      : applyPendingThreadOrder(sortThreadsForListV2(active), "active", pending);
  // Newest send first; finishing and waking again do not move a row.
  const orderedWorking = sortWorkingThreadsBySend(working);
  const orderedSnoozed = [...snoozed].sort(
    (left, right) =>
      parseTimestampMs(left.snoozedUntil ?? "") - parseTimestampMs(right.snoozedUntil ?? ""),
  );
  const selectedThreadKey = input.selectedThreadKey ?? null;
  const visibleWorking =
    input.workingShelfExpanded === true
      ? orderedWorking
      : orderedWorking.filter(
          (thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey,
        );
  const visibleSnoozed =
    input.snoozedShelfExpanded === true
      ? orderedSnoozed
      : orderedSnoozed.filter(
          (thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey,
        );
  const orderedSettled = sortSettledThreads(settled);
  const settledLimit = input.settledLimit ?? Number.POSITIVE_INFINITY;
  const pagedSettled =
    orderedSettled.length > settledLimit ? orderedSettled.slice(0, settledLimit) : orderedSettled;
  const selectedSettled = orderedSettled
    .slice(pagedSettled.length)
    .find((thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey);
  if (selectedSettled !== undefined) pagedSettled.push(selectedSettled);
  const visibleSettled =
    input.settledShelfExpanded !== false
      ? pagedSettled
      : pagedSettled.filter(
          (thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey,
        );

  const items: ThreadListV2Item[] = [];
  for (const thread of applyPendingThreadOrder(
    sortPinnedThreadsByOrderKey(pinned),
    "pinned",
    pending,
  )) {
    items.push({
      thread,
      variant: "card",
      snoozed: false,
      pinned: true,
      readOnly: parsedSearch.filters.archived,
      isLast: false,
    });
  }
  for (const thread of orderedActive) {
    items.push({
      thread,
      variant: "card",
      snoozed: false,
      pinned: false,
      readOnly: parsedSearch.filters.archived,
      isLast: false,
    });
  }
  const workingShelfHeaderIndex = orderedWorking.length > 0 ? items.length : null;
  for (const thread of visibleWorking) {
    items.push({
      thread,
      variant: "card",
      snoozed: false,
      pinned: false,
      readOnly: parsedSearch.filters.archived,
      isLast: false,
    });
  }
  const snoozedShelfHeaderIndex = orderedSnoozed.length > 0 ? items.length : null;
  for (const thread of visibleSnoozed) {
    items.push({
      thread,
      variant: "slim",
      snoozed: true,
      pinned: false,
      readOnly: parsedSearch.filters.archived,
      isLast: false,
    });
  }
  const settledShelfHeaderIndex = orderedSettled.length > 0 ? items.length : null;
  for (const thread of visibleSettled) {
    items.push({
      thread,
      variant: "slim",
      snoozed: false,
      pinned: false,
      readOnly: parsedSearch.filters.archived,
      isLast: false,
    });
  }
  const last = items.at(-1);
  if (last) {
    items[items.length - 1] = { ...last, isLast: true };
  }
  return {
    items,
    hiddenSettledCount: orderedSettled.length - pagedSettled.length,
    workingCount: orderedWorking.length,
    workingShelfHeaderIndex,
    snoozedCount: orderedSnoozed.length,
    snoozedShelfHeaderIndex,
    settledCount: orderedSettled.length,
    settledShelfHeaderIndex,
    nextSnoozeWakeAt,
  };
}
