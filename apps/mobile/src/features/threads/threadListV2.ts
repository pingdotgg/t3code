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
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  resolveThreadProviderStack,
  threadRuntimeAwaitsTurn,
} from "@t3tools/client-runtime/state/models";
import {
  aggregatePipelineStepStatus,
  isPipelineGroupActive,
  livePipelineRunOf,
  nestPipelineSteps,
  pipelineAttentionTargets,
  pipelineEarlierFoldKey,
  pipelineParentsOfSteps,
  pipelineProgressSegments,
  pipelineShownSteps,
  pipelineStepAttempts,
  pipelineStepLabel,
  pipelineStepsOfParents,
  type PipelineLiveRuns,
  type PipelineNestable,
  type PipelineNesting,
  type PipelineProgressStatus,
} from "@t3tools/client-runtime/state/pipeline-nesting";
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
import {
  isListedThreadLineage,
  type EnvironmentId,
  type PipelineRunSummary,
  type ProjectId,
} from "@t3tools/contracts";
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
  | "queued"
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
  if (threadRuntimeAwaitsTurn(thread.runtime)) {
    return "queued";
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

/** What a pipeline's parent row shows for its steps and live run; the row merges it with its own status. */
export function resolveThreadListV2StepStatus(
  steps: ReadonlyArray<Parameters<typeof resolveThreadListV2Status>[0] & PipelineNestable>,
  run?: Pick<PipelineRunSummary, "status" | "currentStepIndex" | "steps"> | null,
) {
  return aggregatePipelineStepStatus(steps, resolveThreadListV2Status, run);
}

/**
 * Folds a section's steps under their parent, where the first of the run sits;
 * a parent the user placed with an order key stays put.
 */
function nestThreadListV2Section(
  sorted: readonly EnvironmentThreadShell[],
  section: "pinned" | "active" | null,
): PipelineNesting<EnvironmentThreadShell> {
  return nestPipelineSteps(sorted, {
    anchored: (parent) =>
      section === "pinned"
        ? parent.pinOrderKey != null
        : section === "active" && parent.activeOrderKey != null,
  });
}

function parseTimestampMs(isoDate: string): number {
  const parsed = Date.parse(isoDate);
  return Number.isNaN(parsed) ? 0 : parsed;
}

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

export function getThreadListV2OrderedSection(input: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly section: "pinned" | "active";
  readonly pendingOrder?: PendingThreadOrder | null;
  readonly now: string;
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys?: ReadonlySet<string>;
}): EnvironmentThreadShell[] {
  const queuedThreadKeys = input.queuedThreadKeys?.size ? input.queuedThreadKeys : undefined;
  const candidates = input.threads.filter(
    (thread) => thread.archivedAt === null && isListedThreadLineage(thread.lineage),
  );
  const parentOfStep = pipelineParentsOfSteps(candidates);
  const threads = candidates.filter((step) => {
    // A pipeline's steps list where their parent lists.
    const thread = parentOfStep.get(`${step.environmentId}:${step.id}`) ?? step;
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
    return (thread.pinnedAt != null) === (input.section === "pinned");
  });
  const ordered = nestThreadListV2Section(
    input.section === "pinned"
      ? sortPinnedThreadsByOrderKey(threads)
      : sortActiveThreadsByOrderKey(threads),
    input.section,
  ).rows;
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
  readonly isLast: boolean;
  /** A pipeline step, listed under its parent. */
  readonly nested?: boolean;
  /** Whether this is the last step of its pipeline. */
  readonly isLastStep?: boolean;
  /** On a pipeline's parent: what its steps and live run need. On a step: what it needs, merged with its own status. */
  readonly stepStatus?: ReturnType<typeof resolveThreadListV2StepStatus>;
  /** On a pipeline step: its label under the parent. */
  readonly stepLabel?: string;
  /** On a step of a live run that will redo it: its finished state is not news, so no unseen "Done". */
  readonly suppressUnseenDone?: boolean;
  /** On an earlier attempt of a step: its number, shown dimmed. */
  readonly earlierAttempt?: number;
  /** The fold row of a pipeline's earlier attempts, listed under its parent. `thread` is the parent. */
  readonly earlierFold?: {
    readonly foldKey: string;
    readonly count: number;
    readonly expanded: boolean;
  };
  /** On a pipeline's parent: the step its attention badge opens; null opens the parent. */
  readonly attentionTarget?: EnvironmentThreadShell | null;
  /** On a pipeline's parent: the name of `attentionTarget`, for the badge's label. */
  readonly attentionLabel?: string;
  /** On a pipeline's parent: one progress bar segment per step, in run order. */
  readonly pipelineProgress?: ReadonlyArray<ThreadListV2PipelineSegment>;
  /** On a pipeline's parent with step rows: whether they all show. Collapsed, only the open step's does. */
  readonly pipelineExpanded?: boolean;
}

export interface ThreadListV2PipelineSegment {
  readonly stepId: string;
  readonly status: PipelineProgressStatus;
}

function samePipelineProgress(
  left: ReadonlyArray<ThreadListV2PipelineSegment> | undefined,
  right: ReadonlyArray<ThreadListV2PipelineSegment> | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  return left.every(
    (segment, index) =>
      segment.stepId === right[index]!.stepId && segment.status === right[index]!.status,
  );
}

export interface ThreadListV2Layout {
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

export type ThreadListV2ListItem =
  | ThreadListV2ThreadListItem
  | ThreadListV2PendingListItem
  | ThreadListV2WorkingShelfListItem
  | ThreadListV2SnoozedShelfListItem
  | ThreadListV2SettledShelfListItem;

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

/** Compare rebuilt items by content so minute ticks and partition runs do not re-render every mounted row. */
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
        previous.item.wokeAt === item.item.wokeAt &&
        previous.item.nested === item.item.nested &&
        previous.item.isLastStep === item.item.isLastStep &&
        previous.item.stepStatus === item.item.stepStatus &&
        previous.item.stepLabel === item.item.stepLabel &&
        previous.item.suppressUnseenDone === item.item.suppressUnseenDone &&
        previous.item.earlierAttempt === item.item.earlierAttempt &&
        previous.item.earlierFold?.foldKey === item.item.earlierFold?.foldKey &&
        previous.item.earlierFold?.count === item.item.earlierFold?.count &&
        previous.item.earlierFold?.expanded === item.item.earlierFold?.expanded &&
        previous.item.attentionTarget === item.item.attentionTarget &&
        previous.item.attentionLabel === item.item.attentionLabel &&
        previous.item.pipelineExpanded === item.item.pipelineExpanded &&
        samePipelineProgress(previous.item.pipelineProgress, item.item.pipelineProgress) &&
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
    (resolveThreadListV2Status(thread) !== "ready" ||
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
      item.nested !== true &&
      item.earlierFold === undefined &&
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
      key: `v2-thread:${item.thread.environmentId}:${item.thread.id}${item.earlierFold ? "#earlier" : ""}`,
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
  const result: ThreadListV2ListItem[] = [...pendingItems, ...threadItems.slice(0, activeEnd)];
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
  /** Live pipeline runs of every environment that offers pipelines. */
  readonly pipelineRuns?: PipelineLiveRuns;
  /** Pipeline parents, as `environmentId:threadId`, that list all their steps. */
  readonly expandedPipelineKeys?: ReadonlyArray<string>;
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
  const parentOfStep = pipelineParentsOfSteps(listedThreads);
  const stepsOfParent = pipelineStepsOfParents(listedThreads, parentOfStep);
  for (const thread of listedThreads) {
    if (matchingThreads !== null && !matchingThreads.has(thread)) {
      const key = threadSearchMatchKey({
        environmentId: thread.environmentId,
        threadId: thread.id,
      });
      if (input.matchedThreadKeys?.has(key) !== true) continue;
      contentOnlyThreadKeys.add(key);
    }
    // A pipeline's steps list where their parent lists, whatever their own state.
    const owner = parentOfStep.get(`${thread.environmentId}:${thread.id}`) ?? thread;
    const supportsSettlement = input.settlementEnvironmentIds?.has(owner.environmentId) ?? true;
    const supportsSnooze = input.snoozeEnvironmentIds?.has(owner.environmentId) ?? true;
    if (supportsSnooze && effectiveSnoozed(owner, { now })) {
      snoozed.push(thread);
      if (
        owner === thread &&
        thread.snoozedUntil != null &&
        (nextSnoozeWakeAt === null ||
          parseTimestampMs(thread.snoozedUntil) < parseTimestampMs(nextSnoozeWakeAt))
      ) {
        nextSnoozeWakeAt = thread.snoozedUntil;
      }
      continue;
    }
    const hasQueuedMessages = queuedThreadKeys?.has(`${owner.environmentId}:${owner.id}`) === true;
    if (supportsSettlement && owner.settledOverride === "settled" && !hasQueuedMessages) {
      settled.push(thread);
    } else if (owner.pinnedAt != null) {
      pinned.push(thread);
    } else if (
      // A pipeline counts as working while any of its steps does, so it stays on the shelf.
      workingShelfEnabled &&
      isPipelineGroupActive(
        owner,
        stepsOfParent,
        input.isWorking ?? isThreadWorking,
        input.pipelineRuns,
      )
    ) {
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
        wokeAt: slim.has(thread) ? null : resolveThreadListV2WokeAt(thread, { now }),
        isLast: index === results.length - 1,
      })),
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

  // Steps sort with everything else, then fold under their parent (see nestThreadListV2Section).
  const nestedPinned = nestThreadListV2Section(sortPinnedThreadsByOrderKey(pinned), "pinned");
  const nestedActive = nestThreadListV2Section(
    workingShelfEnabled
      ? sortInboxThreadsByReturn(active, input.inboxReturnAt)
      : sortThreadsForListV2(active),
    workingShelfEnabled ? null : "active",
  );
  const nestedWorking = nestThreadListV2Section(sortWorkingThreadsBySend(working), null);
  const nestedSnoozed = nestThreadListV2Section(
    [...snoozed].sort(
      (left, right) =>
        parseTimestampMs(left.snoozedUntil ?? "") - parseTimestampMs(right.snoozedUntil ?? ""),
    ),
    null,
  );
  const nestedSettled = nestThreadListV2Section(sortSettledThreadsReusingLast(settled), null);
  const stepsByParentKey = new Map([
    ...nestedPinned.stepsByParentKey,
    ...nestedActive.stepsByParentKey,
    ...nestedWorking.stepsByParentKey,
    ...nestedSnoozed.stepsByParentKey,
    ...nestedSettled.stepsByParentKey,
  ]);
  const orderedActive = workingShelfEnabled
    ? nestedActive.rows
    : applyPendingThreadOrder(nestedActive.rows, "active", pending);
  const orderedWorking = nestedWorking.rows;
  const orderedSnoozed = nestedSnoozed.rows;
  const selectedThreadKey = input.selectedThreadKey ?? null;
  // A collapsed shelf keeps the open thread's row, and the parent's row when a step is open.
  const holdsSelected = (thread: EnvironmentThreadShell) =>
    `${thread.environmentId}:${thread.id}` === selectedThreadKey ||
    stepsByParentKey
      .get(`${thread.environmentId}:${thread.id}`)
      ?.some((step) => `${step.environmentId}:${step.id}` === selectedThreadKey) === true;
  const visibleWorking =
    input.workingShelfExpanded === true ? orderedWorking : orderedWorking.filter(holdsSelected);
  const visibleSnoozed =
    input.snoozedShelfExpanded === true ? orderedSnoozed : orderedSnoozed.filter(holdsSelected);
  const orderedSettled = nestedSettled.rows;
  const listedSettled =
    input.isListedSettled === undefined
      ? orderedSettled
      : orderedSettled.filter(input.isListedSettled);
  const settledTotal = orderedSettled.length + (input.unloadedSettledCount ?? 0);
  const settledLimit = input.settledLimit ?? Number.POSITIVE_INFINITY;
  const limitedSettled =
    listedSettled.length > settledLimit ? listedSettled.slice(0, settledLimit) : listedSettled;
  const selectedSettled =
    selectedThreadKey === null || limitedSettled.some(holdsSelected)
      ? undefined
      : orderedSettled.find(holdsSelected);
  const pagedSettled =
    selectedSettled === undefined ? limitedSettled : [...limitedSettled, selectedSettled];
  const visibleSettled =
    input.settledShelfExpanded !== false ? pagedSettled : pagedSettled.filter(holdsSelected);

  const expandedPipelines = new Set(input.expandedPipelineKeys);
  const items: ThreadListV2Item[] = [];
  // A parent's steps follow it directly, so the list reads in the order it draws. A collapsed
  // pipeline shows its progress bar instead, keeping only the open step's row like a collapsed shelf.
  const pushRow = (
    thread: EnvironmentThreadShell,
    row: Pick<ThreadListV2Item, "variant" | "snoozed" | "pinned" | "wokeAt">,
  ) => {
    const key = `${thread.environmentId}:${thread.id}`;
    const steps = stepsByParentKey.get(key);
    const run = livePipelineRunOf(input.pipelineRuns, thread);
    const progress =
      thread.pipeline != null && thread.pipeline.stepId === null
        ? pipelineProgressSegments(run, steps ?? [], resolveThreadListV2Status)
        : [];
    const expanded = expandedPipelines.has(key);
    const isRun = thread.pipeline != null && thread.pipeline.stepId === null;
    const attempts = steps === undefined ? undefined : pipelineStepAttempts(run, steps);
    const attention = isRun
      ? pipelineAttentionTargets(run, steps ?? [], resolveThreadListV2Status)
      : undefined;
    const foldKey = pipelineEarlierFoldKey(key);
    const foldExpanded = expandedPipelines.has(foldKey);
    const shown =
      attempts === undefined
        ? undefined
        : pipelineShownSteps(attempts, {
            expanded,
            foldExpanded,
            isOpen: (step) => `${step.environmentId}:${step.id}` === selectedThreadKey,
          });
    const attentionStepLabel =
      attention?.target == null
        ? undefined
        : pipelineStepLabel(input.pipelineRuns, attention.target);
    items.push({
      thread,
      ...row,
      isLast: false,
      ...(steps === undefined && run === undefined
        ? {}
        : { stepStatus: resolveThreadListV2StepStatus(steps ?? [], run) }),
      ...(progress.length === 0
        ? {}
        : {
            pipelineProgress: progress.map(({ stepId, status }) => ({ stepId, status })),
          }),
      ...(steps === undefined ? {} : { pipelineExpanded: expanded }),
      ...(attention === undefined
        ? {}
        : { attentionTarget: attention.target, attentionLabel: attentionStepLabel }),
    });
    const stepItem = (step: EnvironmentThreadShell, earlierAttempt?: number): ThreadListV2Item => {
      const stepKey = `${step.environmentId}:${step.id}`;
      const attentionStatus = attention?.attentionThreads.get(stepKey);
      return {
        thread: step,
        variant: "slim",
        snoozed: false,
        pinned: false,
        wokeAt: null,
        isLast: false,
        nested: true,
        stepLabel: pipelineStepLabel(input.pipelineRuns, step),
        ...(attentionStatus === undefined ? {} : { stepStatus: attentionStatus }),
        ...(attempts?.redoKeys.has(stepKey) ? { suppressUnseenDone: true } : {}),
        ...(earlierAttempt === undefined ? {} : { earlierAttempt }),
      };
    };
    const stepItems = [
      ...(shown?.current.map((step) => stepItem(step)) ?? []),
      ...(shown !== undefined && shown.foldCount > 0
        ? [
            {
              thread,
              variant: "slim",
              snoozed: false,
              pinned: false,
              wokeAt: null,
              isLast: false,
              nested: true,
              earlierFold: { foldKey, count: shown.foldCount, expanded: foldExpanded },
            } satisfies ThreadListV2Item,
          ]
        : []),
      ...(shown?.earlier.map((entry) => stepItem(entry.thread, entry.attempt)) ?? []),
    ];
    stepItems.forEach((stepEntry, index) => {
      items.push({ ...stepEntry, isLastStep: index === stepItems.length - 1 });
    });
  };
  for (const thread of applyPendingThreadOrder(nestedPinned.rows, "pinned", pending)) {
    pushRow(thread, {
      variant: "card",
      snoozed: false,
      pinned: true,
      wokeAt: resolveThreadListV2WokeAt(thread, { now }),
    });
  }
  for (const thread of orderedActive) {
    pushRow(thread, {
      variant: "card",
      snoozed: false,
      pinned: false,
      wokeAt: resolveThreadListV2WokeAt(thread, { now }),
    });
  }
  const workingShelfHeaderIndex = orderedWorking.length > 0 ? items.length : null;
  for (const thread of visibleWorking) {
    pushRow(thread, {
      variant: "card",
      snoozed: false,
      pinned: false,
      wokeAt: resolveThreadListV2WokeAt(thread, { now }),
    });
  }
  const snoozedShelfHeaderIndex = orderedSnoozed.length > 0 ? items.length : null;
  for (const thread of visibleSnoozed) {
    pushRow(thread, { variant: "slim", snoozed: true, pinned: false, wokeAt: null });
  }
  const settledShelfHeaderIndex = settledTotal > 0 ? items.length : null;
  for (const thread of visibleSettled) {
    pushRow(thread, { variant: "slim", snoozed: false, pinned: false, wokeAt: null });
  }
  const last = items.at(-1);
  if (last) {
    items[items.length - 1] = { ...last, isLast: true };
  }
  return {
    items,
    hiddenSettledCount: Math.max(0, settledTotal - pagedSettled.length),
    listedSettledThreads: listedSettled,
    workingCount: orderedWorking.length,
    workingShelfHeaderIndex,
    snoozedCount: orderedSnoozed.length,
    snoozedShelfHeaderIndex,
    settledCount: settledTotal,
    settledShelfHeaderIndex,
    nextSnoozeWakeAt,
    contentOnlyThreadKeys,
  };
}
