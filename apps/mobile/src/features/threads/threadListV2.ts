import {
  layoutThreadFolders,
  resolveThreadFolderPlacement,
  type ThreadFolderPlacement,
  scopedThreadFolderKey,
  findThreadFolder,
  type EnvironmentThreadFolder,
  threadFolderCollectChoices,
} from "@t3tools/client-runtime/state/thread-folders";
import {
  canSnooze,
  effectiveSnoozed,
  hasQueuedTurnStart,
  pickSnoozePreset,
  QUEUED_TURN_START_GRACE_MS,
  resolveSnoozePresets,
  snoozeWakeLabel,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  hasUnseenRunFailure,
  type SnoozePreset,
} from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveThreadProviderStack } from "@t3tools/client-runtime/state/models";
import {
  threadSearchMatchKey,
  threadSearchSubject,
} from "@t3tools/client-runtime/state/thread-search";
import { foldSearchQuery, rankSearchItems, scoreThreadSearch } from "@t3tools/shared/paletteSearch";
import {
  createInboxReturnTracker,
  isThreadWorking,
  sortInboxThreadsByReturn,
  sortWorkingThreadsBySend,
} from "@t3tools/client-runtime/state/thread-inbox";
import {
  sortActiveThreadsByOrderKey,
  resolveSettledThreadTimestamp,
  resolveThreadActivityTimestamp,
  sortPinnedThreadsByOrderKey,
  sortSettledThreads,
} from "@t3tools/client-runtime/state/thread-sort";
import { isListedThreadLineage, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import type { SnoozePresetSetting } from "@t3tools/contracts/settings";
import type { MenuAction } from "@react-native-menu/menu";

import type { ThreadListProvider } from "../../state/thread-list-environments";
import type { ThreadMoveAvailability } from "./threadOrder";

import { relativeTime } from "../../lib/time";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";

import {
  applyPendingThreadOrder,
  reconcilePendingThreadOrder,
  type PendingThreadOrder,
} from "./threadOrder";

export const threadListInboxReturns = createInboxReturnTracker();

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

export type ThreadListV2Status =
  | "approval"
  | "input"
  | "request"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";
export type ThreadListV2SwipeAction = "archive" | "settle" | "unsettle" | "snooze" | "unsnooze";

/**
 * Presets for a row's snooze menu, read at the list's minute instead of the
 * clock: the compiler keys a row's memo on its inputs, so a clock read inside
 * it would keep the times from the row's first render.
 */
export function resolveThreadListV2SnoozePresets(input: {
  readonly secondary: "snooze" | null;
  readonly now: string;
  readonly presets: ReadonlyArray<SnoozePresetSetting> | undefined;
}): ReadonlyArray<SnoozePreset> {
  return input.secondary === "snooze"
    ? resolveSnoozePresets(new Date(input.now), presetOptions(input.presets))
    : [];
}

function presetOptions(presets: ReadonlyArray<SnoozePresetSetting> | undefined) {
  return presets ? { presets } : {};
}

export function resolveThreadListV2SnoozeMenuSelection(input: {
  readonly event: string;
  readonly displayedPresets: ReadonlyArray<SnoozePreset>;
  readonly now: Date;
  readonly presets: ReadonlyArray<SnoozePresetSetting> | undefined;
}):
  | { readonly _tag: "selected"; readonly preset: SnoozePreset }
  | { readonly _tag: "expired" }
  | { readonly _tag: "not-snooze" } {
  if (!input.event.startsWith("snooze:")) return { _tag: "not-snooze" };
  const preset = pickSnoozePreset({
    shown: input.displayedPresets,
    id: input.event.slice("snooze:".length),
    now: input.now,
    ...presetOptions(input.presets),
  });
  return preset ? { _tag: "selected", preset } : { _tag: "expired" };
}

export function resolveThreadListV2SwipeActions(input: {
  readonly variant: "card" | "slim";
  readonly settlementSupported: boolean;
  readonly snoozeSupported: boolean;
  readonly snoozable: boolean;
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

// Nested keeps iOS menus short: UIKit scrolls a taller menu, and that scroll
// cancels press-drag-release selection.
export function layoutThreadListV2RowMenuActions(input: {
  readonly nested: boolean;
  readonly direct: readonly MenuAction[];
  readonly reorder: readonly MenuAction[];
  readonly pin: readonly MenuAction[];
  readonly secondary: readonly MenuAction[];
}): MenuAction[] {
  if (!input.nested) {
    return [...input.direct, ...input.reorder, ...input.pin, ...input.secondary];
  }
  return [
    ...input.direct,
    ...input.pin,
    {
      id: "more",
      title: "More",
      image: "ellipsis.circle",
      subactions: [
        ...(input.reorder.length > 1
          ? [
              {
                id: "arrange-menu",
                title: "Arrange",
                image: "arrow.up.arrow.down",
                subactions: [...input.reorder],
              },
            ]
          : input.reorder),
        ...input.secondary,
      ],
    },
  ];
}

export function resolveThreadListV2SnoozeGateExpiryMs(
  thread: Pick<
    EnvironmentThreadShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "latestRun"
    | "latestUserMessageAt"
    | "runtime"
  >,
  options: { readonly now: string },
): number | null {
  if (thread.hasPendingApprovals) return null;
  if (thread.pendingSubagentRequest != null) return null;
  if (!hasQueuedTurnStart(thread, options)) return null;
  const messageAtMs = Date.parse(thread.latestUserMessageAt ?? "");
  if (Number.isNaN(messageAtMs)) return null;
  return messageAtMs + QUEUED_TURN_START_GRACE_MS;
}

/** The earliest `snoozedUntil` strictly after `nowMs`, in epoch ms. */
export function nextSnoozeWakeAfter(
  threads: ReadonlyArray<{ readonly snoozedUntil?: string | null }>,
  nowMs: number,
): number | null {
  let next: number | null = null;
  for (const thread of threads) {
    if (thread.snoozedUntil == null) continue;
    const wakeAtMs = Date.parse(thread.snoozedUntil);
    if (wakeAtMs > nowMs && (next === null || wakeAtMs < next)) next = wakeAtMs;
  }
  return next;
}

// Outside search, the clock only changes list membership/order at snooze deadlines.
export function threadListV2LayoutTime(input: {
  readonly threads: ReadonlyArray<{ readonly snoozedUntil?: string | null }>;
  readonly now: string;
  readonly searchQuery: string;
}) {
  if (input.searchQuery !== "") return input.now;
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) return input.now;
  let previousWakeAt: number | undefined;
  let nextWakeAt: number | undefined;
  for (const thread of input.threads) {
    if (thread.snoozedUntil == null) continue;
    const wakeAt = Date.parse(thread.snoozedUntil);
    if (!Number.isFinite(wakeAt)) continue;
    if (wakeAt <= nowMs) previousWakeAt = Math.max(previousWakeAt ?? wakeAt, wakeAt);
    else nextWakeAt = Math.min(nextWakeAt ?? wakeAt, wakeAt);
  }
  return new Date(previousWakeAt ?? (nextWakeAt === undefined ? 0 : nextWakeAt - 1)).toISOString();
}

export const THREAD_LIST_V2_SETTLED_INITIAL_COUNT = 10;
export const THREAD_LIST_V2_SETTLED_PAGE_COUNT = 25;

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

export type ThreadListV2FolderTallyStatus =
  | "attention"
  | "failed"
  | "unread"
  | "working"
  | "waiting";

const FOLDER_TALLY_ORDER: readonly ThreadListV2FolderTallyStatus[] = [
  "attention",
  "failed",
  "unread",
  "working",
  "waiting",
];

/** A folder header's tally, like the web sidebar's: max 3 statuses, most urgent first. */
export function resolveThreadListV2FolderTally(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ThreadListV2FolderHeaderListItem["tally"] {
  const counts = new Map<ThreadListV2FolderTallyStatus, number>();
  for (const thread of threads) {
    const status = resolveThreadListV2RowStatus(thread);
    const tally: ThreadListV2FolderTallyStatus | null =
      status === "input" || status === "approval" || status === "request" || status === "limited"
        ? "attention"
        : status === "failed"
          ? "failed"
          : status === "ready"
            ? threadHasUnseenCompletion(thread)
              ? "unread"
              : null
            : status === "working"
              ? "working"
              : "waiting";
    if (tally !== null) counts.set(tally, (counts.get(tally) ?? 0) + 1);
  }
  return FOLDER_TALLY_ORDER.flatMap((status) => {
    const count = counts.get(status);
    return count === undefined ? [] : [{ status, count }];
  }).slice(0, 3);
}

/** Key in the collapsed-folder set that marks an open folder's parked footer as expanded. */
export function threadListV2ParkedKey(folderKey: string): string {
  return `${folderKey}:parked`;
}

export function resolveThreadListV2WokeAt(
  thread: EnvironmentThreadShell,
  options: { readonly now: string },
): string | null {
  // Older servers cannot persist an acknowledgement.
  if (thread.lastVisitedAt === undefined || thread.settledOverride === "settled") return null;
  const wokeAt = threadWokeAt(thread, options);
  const wokeAtMs = Date.parse(wokeAt ?? "");
  const lastVisitedAtMs = Date.parse(thread.lastVisitedAt ?? "");
  return !Number.isNaN(wokeAtMs) && (Number.isNaN(lastVisitedAtMs) || lastVisitedAtMs < wokeAtMs)
    ? wokeAt
    : null;
}

export function resolveThreadListV2Status(
  thread: Pick<
    EnvironmentThreadShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "pendingGuestMessageCount"
    | "runtime"
    | "blockedOnThreadWait"
  >,
): ThreadListV2Status {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return "approval";
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return "input";
  }
  // A guest is waiting on the owner; the agent's own requests come first.
  if ((thread.pendingGuestMessageCount ?? 0) > 0) {
    return "request";
  }
  if (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) {
    return "waiting";
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

export function threadListV2RowAccessibilityLabel(input: {
  readonly title: string;
  readonly variant: "card" | "slim";
  readonly woke: boolean;
  readonly statusLabel: string | undefined;
  readonly timeLabel: string;
  readonly snoozeWakeLabel: string | undefined;
  readonly providerNameLabel: string | null;
  readonly hasQueuedMessages: boolean;
  readonly regeneratingTitle: boolean;
}): string {
  // Mirrors the row's meta line: a card shows Woke, else its status, else the time.
  const meta =
    input.variant === "slim"
      ? (input.snoozeWakeLabel ?? input.timeLabel)
      : input.woke
        ? "Woke"
        : (input.statusLabel ?? input.timeLabel);
  return [
    input.title,
    meta,
    input.providerNameLabel,
    input.hasQueuedMessages ? "messages queued to send" : null,
    input.regeneratingTitle ? "regenerating title" : null,
  ]
    .filter((part) => part !== null)
    .join(", ");
}

/** Row status: a failure the user has already opened settles to ready, like Done. */
export function resolveThreadListV2RowStatus(
  thread: Parameters<typeof resolveThreadListV2Status>[0] &
    Pick<EnvironmentThreadShell, "latestRun" | "lastVisitedAt">,
): ThreadListV2Status {
  const status = resolveThreadListV2Status(thread);
  // A runtime failure without a failed run has nothing to date it, so it stays.
  if (status !== "failed" || thread.latestRun?.status !== "failed") return status;
  return hasUnseenRunFailure(thread) ? status : "ready";
}

function parseTimestampMs(isoDate: string): number {
  const parsed = Date.parse(isoDate);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function sortThreadsForListV2<
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

export function getThreadListV2OrderedSection(input: {
  readonly folders?: ReadonlyArray<EnvironmentThreadFolder>;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly section: "pinned" | "active";
  readonly pendingOrder?: PendingThreadOrder | null;
  readonly now: string;
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys?: ReadonlySet<string>;
}): EnvironmentThreadShell[] {
  const unfiled = input.folders?.length
    ? new Set(layoutThreadFolders({ threads: input.threads, folders: input.folders }).unfiled)
    : null;
  const queuedThreadKeys = input.queuedThreadKeys?.size ? input.queuedThreadKeys : undefined;
  const threads = input.threads.filter((thread) => {
    if (thread.archivedAt !== null || !isListedThreadLineage(thread.lineage)) return false;
    if (
      (input.settlementEnvironmentIds?.has(thread.environmentId) ?? true) &&
      thread.settledOverride === "settled" &&
      queuedThreadKeys?.has(`${thread.environmentId}:${thread.id}`) !== true
    ) {
      return false;
    }
    if (
      (input.snoozeEnvironmentIds?.has(thread.environmentId) ?? true) &&
      effectiveSnoozed(thread, { now: input.now })
    ) {
      return false;
    }
    if (unfiled !== null && !unfiled.has(thread)) return false;
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
  readonly snoozed: boolean;
  readonly pinned: boolean;
  readonly wokeAt: string | null;
  readonly folderKey?: string;
  readonly isLast: boolean;
}

export interface ThreadListV2Layout {
  readonly folderHeaders: ReadonlyArray<
    ThreadListV2FolderHeaderListItem & { readonly index: number }
  >;
  readonly items: ThreadListV2Item[];
  readonly hiddenSettledCount: number;
  /** The settled rows the shelf may list, before its visible limit. */
  readonly listedSettledThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly workingCount: number;
  readonly workingShelfHeaderIndex: number | null;
  readonly snoozedCount: number;
  readonly snoozedShelfHeaderIndex: number | null;
  readonly settledCount: number;
  readonly settledShelfHeaderIndex: number | null;
  /** Arm a timeout here to repartition at snooze expiry rather than the next minute tick. */
  readonly nextSnoozeWakeAt: string | null;
  /** Threads listed only because their messages match the search. */
  readonly contentOnlyThreadKeys: ReadonlySet<string>;
}

export interface ThreadListV2ThreadListItem {
  readonly type: "v2-thread";
  readonly key: string;
  readonly item: ThreadListV2Item;
  readonly snoozeWakeLabelText: string | undefined;
  readonly timeLabel: string;
  readonly snoozePresetMinute: string | undefined;
  readonly showTrailingDivider: boolean;
  /** Include queued state in item equality; outbox writes do not update thread shells. */
  readonly hasQueuedMessages: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
}

export interface ThreadListV2PendingListItem {
  readonly type: "v2-pending";
  readonly key: string;
  readonly pendingTask: PendingNewTask;
  readonly showPendingDivider: boolean;
  readonly showTrailingDivider: boolean;
}

export interface ThreadListV2WorkingShelfListItem {
  readonly type: "v2-working-shelf";
  readonly key: "v2-working-shelf";
  readonly count: number;
  readonly expanded: boolean;
  readonly disabled: boolean;
}

export interface ThreadListV2SnoozedShelfListItem {
  readonly type: "v2-snoozed-shelf";
  readonly key: "v2-snoozed-shelf";
  readonly count: number;
  readonly expanded: boolean;
  /** Include disabled state in item equality; recycled cells ignore render-closure updates. */
  readonly disabled: boolean;
}

export interface ThreadListV2SettledShelfListItem {
  readonly type: "v2-settled-shelf";
  readonly key: "v2-settled-shelf";
  readonly count: number;
  readonly expanded: boolean;
  readonly disabled: boolean;
}

export interface ThreadListV2FolderHeaderListItem {
  readonly type: "v2-folder-header";
  readonly settled: boolean;
  /** Every member is settled, even when a pin keeps the folder on top; picks Settle or Un-settle. */
  readonly allSettled: boolean;
  /** Where the folder shows: on top, or on the shelf every member shares. */
  readonly placement: ThreadFolderPlacement;
  /** Members that can still be snoozed, and members now snoozed, for the folder menu. */
  readonly snoozableCount: number;
  readonly snoozedCount: number;
  /** One count per status the live members show, most urgent first. */
  readonly tally: ReadonlyArray<{
    readonly status: ThreadListV2FolderTallyStatus;
    readonly count: number;
  }>;
  /** Members a collapsed folder hides; the selected thread stays shown. */
  readonly hiddenCount: number;
  /** The soonest wake among snoozed members, for the header or footer. */
  readonly nextWakeAt: string | null;
  /** An open top folder's snoozed and settled members, folded into a footer line. */
  readonly parked: {
    readonly snoozedCount: number;
    readonly settledCount: number;
    readonly expanded: boolean;
  } | null;
  /** The folders of this header's section, in screen order, for Move up/down. */
  readonly sectionFolders: ReadonlyArray<EnvironmentThreadFolder>;
  readonly key: string;
  readonly folderKey: string;
  readonly environmentId: EnvironmentId;
  readonly folder: EnvironmentThreadFolder;
  /** Branches and worktrees the Collect menu offers. */
  readonly collectChoices: ReturnType<typeof threadFolderCollectChoices>;
  readonly count: number;
  readonly expanded: boolean;
  readonly disabled: boolean;
}

export interface ThreadListV2FolderParkedListItem {
  readonly type: "v2-folder-parked";
  readonly key: string;
  readonly header: ThreadListV2FolderHeaderListItem;
}

export type ThreadListV2ListItem =
  | ThreadListV2FolderHeaderListItem
  | ThreadListV2FolderParkedListItem
  | ThreadListV2ThreadListItem
  | ThreadListV2PendingListItem
  | ThreadListV2WorkingShelfListItem
  | ThreadListV2SnoozedShelfListItem
  | ThreadListV2SettledShelfListItem;

export function isThreadListV2ListItem(value: {
  readonly type: string;
}): value is ThreadListV2ListItem {
  return (
    value.type === "v2-folder-header" ||
    value.type === "v2-folder-parked" ||
    value.type === "v2-thread" ||
    value.type === "v2-pending" ||
    value.type === "v2-working-shelf" ||
    value.type === "v2-snoozed-shelf" ||
    value.type === "v2-settled-shelf"
  );
}

/** Compare rebuilt items by content so minute ticks and partition runs do not re-render every mounted row. */
export function threadListV2ListItemsAreEqual(
  previous: ThreadListV2ListItem,
  item: ThreadListV2ListItem,
): boolean {
  switch (item.type) {
    case "v2-folder-header":
      return (
        previous.type === item.type &&
        previous.key === item.key &&
        previous.folder === item.folder &&
        JSON.stringify(previous.collectChoices) === JSON.stringify(item.collectChoices) &&
        previous.count === item.count &&
        previous.settled === item.settled &&
        previous.allSettled === item.allSettled &&
        previous.placement === item.placement &&
        previous.snoozableCount === item.snoozableCount &&
        previous.snoozedCount === item.snoozedCount &&
        JSON.stringify(previous.tally) === JSON.stringify(item.tally) &&
        previous.nextWakeAt === item.nextWakeAt &&
        previous.hiddenCount === item.hiddenCount &&
        JSON.stringify(previous.parked) === JSON.stringify(item.parked) &&
        previous.sectionFolders === item.sectionFolders &&
        previous.expanded === item.expanded &&
        previous.disabled === item.disabled
      );
    case "v2-folder-parked":
      return (
        previous.type === "v2-folder-parked" &&
        threadListV2ListItemsAreEqual(previous.header, item.header)
      );
    case "v2-thread":
      return (
        previous.type === "v2-thread" &&
        previous.key === item.key &&
        previous.item.thread === item.item.thread &&
        previous.item.variant === item.item.variant &&
        previous.item.folderKey === item.item.folderKey &&
        previous.item.snoozed === item.item.snoozed &&
        previous.item.pinned === item.item.pinned &&
        previous.item.wokeAt === item.item.wokeAt &&
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

function resolveThreadListV2ItemTimeLabel(
  item: ThreadListV2Item,
  showSnoozeWakeLabel: boolean,
): string {
  const { thread, variant, snoozed } = item;
  if (showSnoozeWakeLabel) return "";
  if (
    variant === "card" &&
    (resolveThreadListV2RowStatus(thread) !== "ready" ||
      item.wokeAt !== null ||
      threadHasUnseenCompletion(thread))
  )
    return "";
  const settledTimestamp =
    variant === "slim" && !snoozed ? resolveSettledThreadTimestamp(thread) : null;
  return relativeTime(
    settledTimestamp ?? resolveThreadActivityTimestamp(thread) ?? thread.createdAt,
  );
}

export function buildThreadListV2ListItems(input: {
  readonly folderHeaders?: ThreadListV2Layout["folderHeaders"];
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
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys?: ReadonlySet<string>;
  readonly moveAvailability?: ReadonlyMap<string, ThreadMoveAvailability>;
  readonly shelfPreferencesLoading?: boolean;
}): ThreadListV2ListItem[] {
  const queuedThreadKeys = input.queuedThreadKeys?.size ? input.queuedThreadKeys : undefined;
  const threadItems = input.items.map((item): ThreadListV2ListItem => {
    const snoozeWakeLabelText =
      item.snoozed && item.thread.snoozedUntil != null && input.snoozeLabelNow !== undefined
        ? snoozeWakeLabel(item.thread.snoozedUntil, { now: input.snoozeLabelNow })
        : undefined;
    // Put the clock on items so recycler equality limits ticks to rows displaying snooze preset times.
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
        queuedThreadKeys?.has(`${item.thread.environmentId}:${item.thread.id}`) === true,
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
  const result: ThreadListV2ListItem[] = [...pendingItems];
  const pushFolders = (folders: ThreadListV2Layout["folderHeaders"], index: number) => {
    for (const header of folders) {
      if (header.index === index) {
        result.push({ ...header, disabled: input.shelfPreferencesLoading === true });
      }
    }
  };
  const foldersAt = (placement: ThreadFolderPlacement) =>
    (input.folderHeaders ?? []).filter((header) => header.placement === placement);
  const pushRange = (folders: ThreadListV2Layout["folderHeaders"], from: number, to: number) => {
    for (let index = from; index <= to; index += 1) {
      pushFolders(folders, index);
      if (index < to) result.push(threadItems[index]!);
    }
  };
  pushRange(foldersAt("open"), 0, activeEnd);
  const shelfDisabled = input.shelfPreferencesLoading === true;
  if (workingShelfHeaderIndex !== null && workingCount > 0) {
    result.push({
      type: "v2-working-shelf",
      key: "v2-working-shelf",
      count: workingCount,
      expanded: input.workingShelfExpanded === true,
      disabled: shelfDisabled,
    });
    pushRange(foldersAt("working"), workingShelfHeaderIndex, workingEnd);
  }
  if (snoozedShelfHeaderIndex !== null && snoozedCount > 0) {
    result.push({
      type: "v2-snoozed-shelf",
      key: "v2-snoozed-shelf",
      count: snoozedCount,
      expanded: input.snoozedShelfExpanded === true,
      disabled: shelfDisabled,
    });
    pushRange(foldersAt("snoozed"), snoozedShelfHeaderIndex, snoozedEnd);
  }
  if (settledShelfHeaderIndex !== null && settledCount > 0) {
    result.push({
      type: "v2-settled-shelf",
      key: "v2-settled-shelf",
      count: settledCount,
      expanded: input.settledShelfExpanded !== false,
      disabled: shelfDisabled,
    });
    pushRange(foldersAt("settled"), settledShelfHeaderIndex, threadItems.length);
  }
  // An open top folder's parked footer heads its shown snoozed and settled members.
  for (const header of input.folderHeaders ?? []) {
    if (header.parked === null) continue;
    const headerIndex = result.findIndex(
      (entry) => entry.type === "v2-folder-header" && entry.folderKey === header.folderKey,
    );
    if (headerIndex === -1) continue;
    let end = headerIndex + 1;
    while (
      end < result.length &&
      result[end]!.type === "v2-thread" &&
      (result[end] as ThreadListV2ThreadListItem).item.folderKey === header.folderKey &&
      (result[end] as ThreadListV2ThreadListItem).item.variant !== "slim"
    ) {
      end += 1;
    }
    result.splice(end, 0, {
      type: "v2-folder-parked",
      key: `v2-folder-parked:${header.folderKey}`,
      header: result[headerIndex] as ThreadListV2FolderHeaderListItem,
    });
  }
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

// Immutable shells and field-only sorting make element-identical inputs produce identical output.
let lastSettledInput: ReadonlyArray<EnvironmentThreadShell> = [];
let lastSettledOutput: ReadonlyArray<EnvironmentThreadShell> = [];

function sortSettledThreadsReusingLast(
  settled: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  if (settled.length === lastSettledInput.length) {
    let same = true;
    for (let index = 0; index < settled.length; index += 1) {
      if (settled[index] !== lastSettledInput[index]) {
        same = false;
        break;
      }
    }
    if (same) return lastSettledOutput;
  }
  lastSettledInput = settled;
  lastSettledOutput = sortSettledThreads(settled);
  return lastSettledOutput;
}

export function buildThreadListV2Items(input: {
  readonly folders?: ReadonlyArray<EnvironmentThreadFolder>;
  readonly collapsedFolderKeys?: ReadonlySet<string>;
  readonly pendingOrder?: PendingThreadOrder | null;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs?: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }> | null;
  readonly searchQuery: string;
  readonly matchedThreadKeys?: ReadonlySet<string>;
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly settledLimit?: number;
  readonly now: string;
  readonly workingShelfEnabled?: boolean;
  readonly workingShelfExpanded?: boolean;
  readonly isWorking?: (thread: EnvironmentThreadShell) => boolean;
  readonly inboxReturnAt?: (thread: EnvironmentThreadShell) => number | undefined;
  readonly snoozedShelfExpanded?: boolean;
  readonly settledShelfExpanded?: boolean;
  readonly selectedThreadKey?: string | null;
  readonly queuedThreadKeys?: ReadonlySet<string>;
  /** Whether the shelf may list a settled row yet; older settled rows load in pages. */
  readonly isListedSettled?: (thread: EnvironmentThreadShell) => boolean;
  /** Settled threads in scope that are not local (older settled threads not loaded). */
  readonly unloadedSettledCount?: number;
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
  const query = foldSearchQuery(input.searchQuery);
  const nowMs = Date.parse(now);
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
  const queuedThreadKeys = input.queuedThreadKeys?.size ? input.queuedThreadKeys : undefined;
  const listedThreads = input.threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      isListedThreadLineage(thread.lineage) &&
      (input.environmentId === null || thread.environmentId === input.environmentId) &&
      (projectKeys === null || projectKeys.has(`${thread.environmentId}:${thread.projectId}`)),
  );
  // The same matches as the command palette, typo fallback included. Only
  // listed threads are ranked: a hidden exact match must not turn typos off.
  const rankedMatches =
    query.length > 0
      ? rankSearchItems(listedThreads, (thread, options) =>
          scoreThreadSearch(query, threadSearchSubject(thread, null), nowMs, {
            ...options,
            picks: false,
          }),
        ).map(({ item }) => item)
      : null;
  const matchingThreads = rankedMatches === null ? null : new Set(rankedMatches);
  // Threads listed only because their messages match; only their rows show
  // the message and open at it.
  const contentOnlyThreadKeys = new Set<string>();
  for (const thread of listedThreads) {
    if (matchingThreads !== null && !matchingThreads.has(thread)) {
      const key = threadSearchMatchKey({
        environmentId: thread.environmentId,
        threadId: thread.id,
      });
      if (input.matchedThreadKeys?.has(key) !== true) continue;
      contentOnlyThreadKeys.add(key);
    }
    const supportsSettlement = input.settlementEnvironmentIds?.has(thread.environmentId) ?? true;
    const supportsSnooze = input.snoozeEnvironmentIds?.has(thread.environmentId) ?? true;
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
      queuedThreadKeys?.has(`${thread.environmentId}:${thread.id}`) === true;
    if (supportsSettlement && thread.settledOverride === "settled" && !hasQueuedMessages) {
      settled.push(thread);
    } else if (thread.pinnedAt != null) {
      pinned.push(thread);
    } else if (workingShelfEnabled && (input.isWorking ?? isThreadWorking)(thread)) {
      working.push(thread);
    } else {
      active.push(thread);
    }
  }

  if (rankedMatches !== null) {
    // Searching lists every match by rank across shelves, as the palette and
    // the web sidebar do, then threads listed for their messages in the
    // server's order. Each row keeps its shelf's look.
    const slim = new Set([...snoozed, ...settled]);
    const snoozedThreads = new Set(snoozed);
    const pinnedThreads = new Set(pinned);
    const threadByKey = new Map(
      listedThreads.map((thread) => [
        threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
        thread,
      ]),
    );
    const contentOnly = [...(input.matchedThreadKeys ?? [])].flatMap((key) => {
      const thread = contentOnlyThreadKeys.has(key) ? threadByKey.get(key) : undefined;
      return thread ? [thread] : [];
    });
    const results = [...rankedMatches, ...contentOnly];
    return {
      items: results.map((thread, index) => ({
        thread,
        variant: slim.has(thread) ? "slim" : "card",
        snoozed: snoozedThreads.has(thread),
        pinned: pinnedThreads.has(thread),
        folderKey: (() => {
          const folder = findThreadFolder(input.folders ?? [], thread);
          return folder ? scopedThreadFolderKey(folder) : undefined;
        })(),
        wokeAt: slim.has(thread) ? null : resolveThreadListV2WokeAt(thread, { now }),
        isLast: index === results.length - 1,
      })),
      folderHeaders: [],
      hiddenSettledCount: 0,
      listedSettledThreads: [],
      workingCount: 0,
      workingShelfHeaderIndex: null,
      snoozedCount: 0,
      snoozedShelfHeaderIndex: null,
      settledCount: 0,
      settledShelfHeaderIndex: null,
      nextSnoozeWakeAt,
      contentOnlyThreadKeys,
    };
  }

  const orderedPinned = sortPinnedThreadsByOrderKey(pinned);
  const allOrderedSnoozed = [...snoozed].sort(
    (left, right) =>
      parseTimestampMs(left.snoozedUntil ?? "") - parseTimestampMs(right.snoozedUntil ?? ""),
  );
  const allOrderedSettled = sortSettledThreadsReusingLast(settled);
  const folderLayout = layoutThreadFolders({
    threads: [
      ...orderedPinned,
      // Filed threads keep the order their shelf would give them.
      ...(workingShelfEnabled
        ? [
            ...sortInboxThreadsByReturn(active, input.inboxReturnAt),
            ...sortWorkingThreadsBySend(working),
          ]
        : sortThreadsForListV2([...active, ...working])),
      ...allOrderedSnoozed,
      ...allOrderedSettled,
    ],
    folders: (input.folders ?? []).filter(
      (folder) => input.environmentId === null || folder.environmentId === input.environmentId,
    ),
  });
  const unfiled = new Set(folderLayout.unfiled);
  const unfiledActive = active.filter((thread) => unfiled.has(thread));
  const unfiledWorking = working.filter((thread) => unfiled.has(thread));
  const orderedActive = workingShelfEnabled
    ? sortInboxThreadsByReturn(unfiledActive, input.inboxReturnAt)
    : applyPendingThreadOrder(sortThreadsForListV2(unfiledActive), "active", pending);
  const orderedWorking = sortWorkingThreadsBySend(unfiledWorking);
  const orderedSnoozed = allOrderedSnoozed.filter((thread) => unfiled.has(thread));
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
  const orderedSettled = allOrderedSettled.filter((thread) => unfiled.has(thread));
  const listedSettled =
    input.isListedSettled === undefined
      ? orderedSettled
      : orderedSettled.filter(input.isListedSettled);
  const settledTotal = orderedSettled.length + (input.unloadedSettledCount ?? 0);
  const settledLimit = input.settledLimit ?? Number.POSITIVE_INFINITY;
  const limitedSettled =
    listedSettled.length > settledLimit ? listedSettled.slice(0, settledLimit) : listedSettled;
  const selectedSettled =
    selectedThreadKey === null ||
    limitedSettled.some((thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey)
      ? undefined
      : orderedSettled.find(
          (thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey,
        );
  const pagedSettled =
    selectedSettled === undefined ? limitedSettled : [...limitedSettled, selectedSettled];
  const visibleSettled =
    input.settledShelfExpanded !== false
      ? pagedSettled
      : pagedSettled.filter(
          (thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey,
        );

  const items: ThreadListV2Item[] = [];
  for (const thread of applyPendingThreadOrder(
    orderedPinned.filter((thread) => unfiled.has(thread)),
    "pinned",
    pending,
  )) {
    items.push({
      thread,
      variant: "card",
      snoozed: false,
      pinned: true,
      wokeAt: resolveThreadListV2WokeAt(thread, { now }),
      isLast: false,
    });
  }
  for (const thread of orderedActive) {
    items.push({
      thread,
      variant: "card",
      snoozed: false,
      pinned: false,
      wokeAt: resolveThreadListV2WokeAt(thread, { now }),
      isLast: false,
    });
  }
  const snoozedThreads = new Set(snoozed);
  const settledThreads = new Set(settled);
  const pinnedThreads = new Set(pinned);
  const workingThreads = new Set(working);
  const folderHeaders: Array<ThreadListV2FolderHeaderListItem & { readonly index: number }> = [];
  type FolderBlock = (typeof folderLayout.blocks)[number];
  const placementOf = (block: FolderBlock) =>
    resolveThreadFolderPlacement(
      block.threads.map((thread) =>
        snoozedThreads.has(thread)
          ? "snoozed"
          : settledThreads.has(thread)
            ? "settled"
            : pinnedThreads.has(thread)
              ? "pinned"
              : workingThreads.has(thread)
                ? "working"
                : "active",
      ),
      { folderPinned: block.folder.pinnedAt != null },
    );
  const blocksAt = (placement: ThreadFolderPlacement) =>
    folderLayout.blocks.filter((block) => placementOf(block) === placement);
  const shelfExpanded = {
    working: input.workingShelfExpanded === true,
    snoozed: input.snoozedShelfExpanded === true,
    settled: input.settledShelfExpanded !== false,
  };
  const pushFolder = (block: FolderBlock) => {
    const placement = placementOf(block);
    const settled = placement === "settled";
    // Settled folders start collapsed, and shelf folders fold away with a closed shelf.
    const expanded =
      (input.collapsedFolderKeys?.has(block.key) ?? false) === settled &&
      !(placement !== "open" && !shelfExpanded[placement]);
    const parkedMembers = block.threads.filter(
      (thread) => snoozedThreads.has(thread) || settledThreads.has(thread),
    );
    const snoozedMembers = parkedMembers.filter((thread) => snoozedThreads.has(thread));
    let nextWakeAt: string | null = null;
    for (const thread of snoozedMembers) {
      if (
        thread.snoozedUntil != null &&
        (nextWakeAt === null ||
          parseTimestampMs(thread.snoozedUntil) < parseTimestampMs(nextWakeAt))
      ) {
        nextWakeAt = thread.snoozedUntil;
      }
    }
    // Only an open top folder folds its parked members; on a shelf they are the whole folder.
    const parked =
      expanded && placement === "open" && parkedMembers.length > 0
        ? {
            snoozedCount: snoozedMembers.length,
            settledCount: parkedMembers.length - snoozedMembers.length,
            expanded: input.collapsedFolderKeys?.has(threadListV2ParkedKey(block.key)) ?? false,
          }
        : null;
    folderHeaders.push({
      type: "v2-folder-header",
      key: `v2-folder:${block.key}`,
      folderKey: block.key,
      environmentId: block.folder.environmentId,
      folder: block.folder,
      collectChoices: threadFolderCollectChoices(block.folder, input.threads),
      count: block.threads.length,
      settled,
      allSettled:
        block.threads.length > 0 && block.threads.every((thread) => settledThreads.has(thread)),
      placement,
      snoozableCount: block.threads.filter(
        (thread) =>
          !snoozedThreads.has(thread) && !settledThreads.has(thread) && canSnooze(thread, { now }),
      ).length,
      snoozedCount: block.threads.filter((thread) => thread.snoozedUntil != null).length,
      tally: resolveThreadListV2FolderTally(
        block.threads.filter(
          (thread) => !snoozedThreads.has(thread) && !settledThreads.has(thread),
        ),
      ),
      nextWakeAt: placement === "snoozed" || parked !== null ? nextWakeAt : null,
      hiddenCount: expanded
        ? 0
        : block.threads.filter(
            (thread) => `${thread.environmentId}:${thread.id}` !== selectedThreadKey,
          ).length,
      parked,
      sectionFolders: blocksAt(placement)
        .filter(
          (candidate) => (candidate.folder.pinnedAt != null) === (block.folder.pinnedAt != null),
        )
        .map((candidate) => candidate.folder),
      expanded,
      disabled: false,
      index: items.length,
    });
    for (const thread of block.threads) {
      const selected = `${thread.environmentId}:${thread.id}` === selectedThreadKey;
      if (!expanded && !selected) continue;
      if (parked !== null && !parked.expanded && parkedMembers.includes(thread) && !selected) {
        continue;
      }
      items.push({
        thread,
        variant: snoozedThreads.has(thread) || settledThreads.has(thread) ? "slim" : "card",
        snoozed: snoozedThreads.has(thread),
        pinned: pinnedThreads.has(thread),
        folderKey: block.key,
        wokeAt:
          snoozedThreads.has(thread) || settledThreads.has(thread)
            ? null
            : resolveThreadListV2WokeAt(thread, { now }),
        isLast: false,
      });
    }
  };
  const pushShelfFolders = (placement: "working" | "snoozed" | "settled") => {
    for (const block of blocksAt(placement)) {
      if (
        shelfExpanded[placement] ||
        block.threads.some((thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey)
      ) {
        pushFolder(block);
      }
    }
  };
  const shelfFolderCount = (placement: "working" | "snoozed" | "settled") =>
    blocksAt(placement).reduce((total, block) => total + block.threads.length, 0);
  for (const block of blocksAt("open")) pushFolder(block);
  const workingCount = orderedWorking.length + shelfFolderCount("working");
  const workingShelfHeaderIndex = workingCount > 0 ? items.length : null;
  pushShelfFolders("working");
  for (const thread of visibleWorking) {
    items.push({
      thread,
      variant: "card",
      snoozed: false,
      pinned: false,
      wokeAt: resolveThreadListV2WokeAt(thread, { now }),
      isLast: false,
    });
  }
  const snoozedCount = orderedSnoozed.length + shelfFolderCount("snoozed");
  const snoozedShelfHeaderIndex = snoozedCount > 0 ? items.length : null;
  pushShelfFolders("snoozed");
  for (const thread of visibleSnoozed) {
    items.push({
      thread,
      variant: "slim",
      snoozed: true,
      pinned: false,
      wokeAt: null,
      isLast: false,
    });
  }
  const settledFolderCount = shelfFolderCount("settled");
  const settledShelfHeaderIndex =
    settledTotal > 0 || blocksAt("settled").length > 0 ? items.length : null;
  pushShelfFolders("settled");
  for (const thread of visibleSettled) {
    items.push({
      thread,
      variant: "slim",
      snoozed: false,
      pinned: false,
      wokeAt: null,
      isLast: false,
    });
  }
  const last = items.at(-1);
  if (last) {
    items[items.length - 1] = { ...last, isLast: true };
  }
  return {
    items,
    folderHeaders,
    hiddenSettledCount: Math.max(0, settledTotal - pagedSettled.length),
    listedSettledThreads: listedSettled,
    workingCount,
    workingShelfHeaderIndex,
    snoozedCount,
    snoozedShelfHeaderIndex,
    settledCount: settledTotal + settledFolderCount,
    settledShelfHeaderIndex,
    nextSnoozeWakeAt,
    contentOnlyThreadKeys,
  };
}
