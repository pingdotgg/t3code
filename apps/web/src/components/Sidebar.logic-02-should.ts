import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import * as React from "react";
import {
  isAtomCommandInterrupted,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { defaultAnimateLayoutChanges, type AnimateLayoutChanges } from "@dnd-kit/sortable";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  isListedThreadLineage,
  type ContextMenuItem,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import type { AsyncResult } from "effect/reactivity";
import {
  effectiveSnoozed,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  getThreadSortTimestamp,
  planPinnedReorder,
  sortThreads,
  toSortableTimestamp,
  type ThreadSortInput,
} from "@t3tools/client-runtime/state/thread-sort";
import type { SidebarThreadSummary, Thread } from "../types";
import { observeIntersection } from "../lib/observeIntersection";
import { deadlineAfter, deadlineStore } from "@t3tools/client-runtime/clock";
import { useDeadlinePassed } from "../hooks/useDeadline";

export function shouldNavigateAfterThreadPark(input: {
  readonly threadKey: string;
  readonly currentThreadKey: string | null;
  readonly action: "settle" | "snooze";
  readonly now: string;
  readonly thread: (ThreadSnoozeShell & Pick<SidebarThreadSummary, "settledOverride">) | null;
}): boolean {
  return (
    input.threadKey === input.currentThreadKey &&
    input.thread !== null &&
    (input.action === "settle"
      ? input.thread.settledOverride === "settled"
      : effectiveSnoozed(input.thread, { now: input.now }))
  );
}

export const THREAD_JUMP_HINT_SHOW_DELAY_MS = 200;

export function resolveSidebarRowAccessibility(input: {
  readonly title: string;
  readonly statusLabel: string | null;
  readonly projectDisplayName: string | null;
  readonly isActive: boolean;
}): { readonly label: string; readonly current: "page" | undefined } {
  return {
    label: [input.title, input.statusLabel, input.projectDisplayName].filter(Boolean).join(", "),
    current: input.isActive ? "page" : undefined,
  };
}

// Each prewarm retains growing thread detail and a live subscription, multiplying heap and server load.
export const SIDEBAR_ROW_SUBSCRIPTION_OVERSCAN_PX = 160;

export function useSidebarRowSubscriptionLease(isActive: boolean): {
  readonly leaseLiveStatus: boolean;
  readonly rowRef: (row: HTMLElement | null) => (() => void) | undefined;
} {
  const [isNearViewport, setIsNearViewport] = React.useState(isActive);
  if (isActive && !isNearViewport) setIsNearViewport(true);
  const canObserve = typeof IntersectionObserver !== "undefined";

  return {
    leaseLiveStatus: isActive || isNearViewport || !canObserve,
    rowRef: (row) => {
      if (row === null || isActive || !canObserve) return undefined;
      // The overscan has to apply to the sidebar's own scroller; a viewport-rooted
      // margin is still clipped by it.
      return observeIntersection(row, (entry) => setIsNearViewport(entry.isIntersecting), {
        root: row.closest('[data-slot="scroll-area-viewport"]'),
        rootMargin: `${SIDEBAR_ROW_SUBSCRIPTION_OVERSCAN_PX}px 0px`,
      });
    },
  };
}

export const fileDragClears = new Set<(active: false) => void>();
export function clearFileDrags() {
  const clears = [...fileDragClears];
  fileDragClears.clear();
  for (const clear of clears) clear(false);
}

/**
 * A file drag that ends outside every drop target (Escape, or a drop elsewhere)
 * sends no dragleave to the row it last entered, so the window's dragend clears it.
 */
export function setFileDragActive(setActive: (active: boolean) => void, active: boolean) {
  setActive(active);
  if (typeof window === "undefined") return;
  if (!active) {
    if (fileDragClears.delete(setActive) && fileDragClears.size === 0) {
      window.removeEventListener("dragend", clearFileDrags);
    }
    return;
  }
  if (fileDragClears.size === 0) window.addEventListener("dragend", clearFileDrags, { once: true });
  fileDragClears.add(setActive);
}

/**
 * A clock that advances exactly when a snooze wake time passes, so a woken
 * thread leaves the shelf on time without a per-second clock.
 */
export function useSnoozeWakeClock(
  threads: ReadonlyArray<{ readonly snoozedUntil?: string | null | undefined }>,
): number {
  const [clockMs, setClockMs] = React.useState(() => Date.now());
  const wakeTimes: number[] = [];
  let nextWakeAt: number | null = null;
  for (const thread of threads) {
    const wakeAt = thread.snoozedUntil == null ? Number.NaN : Date.parse(thread.snoozedUntil);
    if (!(wakeAt > clockMs)) continue;
    wakeTimes.push(wakeAt);
    if (nextWakeAt === null || wakeAt < nextWakeAt) nextWakeAt = wakeAt;
  }
  const woke = useDeadlinePassed(nextWakeAt);
  // Advancing to the latest wake that has passed skips every wake that elapsed
  // meanwhile, e.g. across a laptop sleep. Stepping one wake at a time would
  // re-render once per elapsed wake and hit React's limit.
  if (woke && nextWakeAt !== null) {
    let nextClockMs = nextWakeAt;
    for (const wakeAt of wakeTimes) {
      if (wakeAt > nextClockMs && deadlineStore(wakeAt).getSnapshot()) nextClockMs = wakeAt;
    }
    setClockMs(nextClockMs);
    return nextClockMs;
  }
  return clockMs;
}

export function useRetainedValue<T>(key: string | null, value: T | null): T | null {
  const [retained, setRetained] = React.useState<{
    readonly key: string;
    readonly value: T;
  } | null>(null);
  if (key !== null && value !== null && (retained?.key !== key || retained.value !== value)) {
    setRetained({ key, value });
  }
  if (value !== null) return value;
  return key !== null && retained?.key === key ? retained.value : null;
}

// Sortable owns drag transforms; replaying committed order would animate drops twice.
export const animateSidebarLayoutChanges: AnimateLayoutChanges = (args) =>
  args.isSorting ? defaultAnimateLayoutChanges(args) : false;

// Snoozed rows cannot accept drops without a wake time. Working rows only drag out as chat context.

export type SidebarSection = "pinned" | "active" | "working" | "snoozed" | "settled";

export function resolveSidebarThreadSection(input: {
  readonly snoozed: boolean;
  readonly settled: boolean;
  readonly pinned: boolean;
}): SidebarSection {
  if (input.snoozed) return "snoozed";
  if (input.settled) return "settled";
  if (input.pinned) return "pinned";
  return "active";
}

// Keep cached placement on the first connection attempt, matching mobile's threadRouteIsHydrating.
export function isSidebarEnvironmentDisconnected(
  phase: EnvironmentConnectionPhase,
  shellIsLive: boolean,
): boolean {
  return phase !== "connecting" && (phase !== "connected" || !shellIsLive);
}

export function belongsInSidebarWorkingShelf<T extends { readonly environmentId: EnvironmentId }>(
  thread: T,
  input: {
    readonly enabled: boolean;
    readonly disconnectedEnvironmentIds: ReadonlySet<EnvironmentId>;
    readonly isWorking: (thread: T) => boolean;
  },
): boolean {
  return (
    input.enabled &&
    !input.disconnectedEnvironmentIds.has(thread.environmentId) &&
    input.isWorking(thread)
  );
}

export const SIDEBAR_MARKER_PREFIX = "sidebar-marker-";

export type SidebarListMarker =
  | "pinned-header"
  | "active-placeholder"
  | "settled-placeholder"
  | "pinned-divider"
  | "working-header"
  | "snoozed-header"
  | "settled-header";

export function sidebarMarkerId(marker: SidebarListMarker): string {
  return `${SIDEBAR_MARKER_PREFIX}${marker}`;
}

export type SidebarListItem =
  | { readonly kind: "thread"; readonly key: string; readonly section: SidebarSection }
  | { readonly kind: "marker"; readonly marker: SidebarListMarker };

export function sidebarListItemId(item: SidebarListItem): string {
  return item.kind === "thread" ? item.key : sidebarMarkerId(item.marker);
}

export function sectionAtSidebarSlot(items: readonly SidebarListItem[], index: number): SidebarSection {
  let section: SidebarSection = "pinned";
  for (let i = 0; i < index && i < items.length; i += 1) {
    const item = items[i]!;
    if (item.kind !== "marker") continue;
    if (item.marker === "pinned-divider") section = "active";
    else if (item.marker === "working-header") section = "working";
    else if (item.marker === "snoozed-header") section = "snoozed";
    else if (item.marker === "settled-header") section = "settled";
  }
  return section;
}

export type SidebarDropTarget = {
  readonly section: "pinned" | "active" | "settled";
  readonly pinnedOrder: readonly string[];
  readonly activeOrder: readonly string[];
};

export function resolveSidebarDropTarget(
  items: readonly SidebarListItem[],
  activeKey: string,
  overId: string,
): SidebarDropTarget | null {
  const activeIndex = items.findIndex((item) => sidebarListItemId(item) === activeKey);
  const overIndex = items.findIndex((item) => sidebarListItemId(item) === overId);
  if (activeIndex === -1 || overIndex === -1 || items[activeIndex]?.kind !== "thread") return null;
  const moved = items.filter((_, index) => index !== activeIndex);
  moved.splice(overIndex, 0, items[activeIndex]!);
  const section = sectionAtSidebarSlot(moved, overIndex);
  if (section === "working" || section === "snoozed") return null;
  const pinnedOrder: string[] = [];
  const activeOrder: string[] = [];
  let currentSection: SidebarSection = "pinned";
  for (const item of moved) {
    if (item.kind === "marker") {
      if (item.marker === "pinned-divider") currentSection = "active";
      else if (
        item.marker === "working-header" ||
        item.marker === "snoozed-header" ||
        item.marker === "settled-header"
      )
        break;
    } else if (currentSection === "pinned") pinnedOrder.push(item.key);
    else activeOrder.push(item.key);
  }
  return { section, pinnedOrder, activeOrder };
}

export type SidebarThreadDropPlan =
  | { readonly kind: "none" }
  | {
      readonly kind: "reorder-pinned";
      readonly order: readonly string[];
      readonly assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
    }
  | {
      readonly kind: "pin";
      readonly order: readonly string[];
      readonly orderKey: string | undefined;
      readonly extraAssignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
    }
  | {
      readonly kind: "move-active";
      readonly order: readonly string[] | null;
      readonly assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>;
      readonly unpin: boolean;
      readonly unsettle: boolean;
      readonly unsnooze: boolean;
    }
  | { readonly kind: "settle" };

export type SidebarDropVerb = "pin" | "unpin" | "settle" | "unsettle" | "wake";

export function resolveSidebarDropVerb(
  from: SidebarSection,
  to: SidebarSection | null,
): SidebarDropVerb | null {
  if (to === null || to === from || to === "working" || to === "snoozed") return null;
  if (to === "pinned") return "pin";
  if (to === "settled") return "settle";
  if (from === "pinned") return "unpin";
  if (from === "settled") return "unsettle";
  return "wake";
}

export function resolveSidebarSweepKeys(
  orderedKeys: readonly string[],
  originKey: string,
  targetKey: string,
  canApply: (key: string) => boolean,
): string[] {
  const origin = orderedKeys.indexOf(originKey);
  const target = orderedKeys.indexOf(targetKey);
  if (origin === -1 || target === -1) return [];
  return orderedKeys.slice(Math.min(origin, target), Math.max(origin, target) + 1).filter(canApply);
}

export function sidebarThreadKeyAtY(list: HTMLElement, y: number): string | null {
  const viewport = list.closest('[data-slot="scroll-area-viewport"]')?.getBoundingClientRect();
  const visibleY = viewport ? Math.min(Math.max(y, viewport.top), viewport.bottom - 1) : y;
  let key: string | null = null;
  for (const row of list.querySelectorAll<HTMLElement>("li[data-thread-item]")) {
    if (key !== null && row.getBoundingClientRect().top > visibleY) break;
    key = row.dataset.threadItem ?? null;
  }
  return key;
}

export function resolveSidebarReorderableThreadKeys(input: {
  readonly threads: ReadonlyArray<Pick<SidebarThreadSummary, "environmentId" | "id">>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, Pick<EnvironmentServerConfig, "environment">>;
  readonly connectedEnvironmentIds: readonly EnvironmentId[];
}) {
  const connectedEnvironmentIds = new Set(input.connectedEnvironmentIds);
  const draggableThreadKeys = new Set<string>();
  const activeReorderableThreadKeys = new Set<string>();

  for (const thread of input.threads) {
    // Config is cached for offline rendering, so its presence does not make a row writable.
    if (
      !connectedEnvironmentIds.has(thread.environmentId) ||
      !input.serverConfigs.has(thread.environmentId)
    ) {
      continue;
    }

    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    activeReorderableThreadKeys.add(threadKey);
    draggableThreadKeys.add(threadKey);
  }

  return { draggableThreadKeys, activeReorderableThreadKeys };
}

export function planSidebarThreadDrop(input: {
  readonly activeKey: string;
  readonly activeSection: SidebarSection;
  readonly activePinned?: boolean;
  readonly activeSettled?: boolean;
  readonly supportsSettlement?: boolean;
  readonly target: SidebarDropTarget;
  readonly pinnedOrder: readonly string[];
  readonly pinnedKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly reorderableKeys?: ReadonlySet<string>;
  readonly activeOrder: readonly string[];
  readonly activeKeysById: ReadonlyMap<string, string | null | undefined>;
  readonly activeReorderableKeys?: ReadonlySet<string>;
  readonly activeTimeOrdered?: boolean;
}): SidebarThreadDropPlan {
  const {
    activeKey,
    activeSection,
    activePinned = activeSection === "pinned",
    activeSettled = activeSection === "settled",
    target,
    pinnedOrder,
    pinnedKeysById,
    reorderableKeys,
    activeOrder,
    activeKeysById,
    activeReorderableKeys,
  } = input;
  if (activeSection === "working") return { kind: "none" };
  if (input.supportsSettlement === false && (target.section === "settled" || activeSettled)) {
    return { kind: "none" };
  }
  const arrange = (
    order: readonly string[],
    keysById: ReadonlyMap<string, string | null | undefined>,
    writable: ReadonlySet<string> | undefined,
  ) => {
    if (!writable) return planPinnedReorder({ orderedIds: order, keysById, movedId: activeKey });
    if (!writable.has(activeKey)) return null;
    const assignments = planPinnedReorder({
      orderedIds: order.filter((key) => writable.has(key) || keysById.get(key) != null),
      keysById,
      movedId: activeKey,
    });
    if (assignments.some(({ id }) => !writable.has(id))) return null;

    // Keyless Active rows sort before keyed rows; keyless Pinned rows sort after them.
    // Materializing any row across a frozen keyless boundary cannot persist that position.
    const assignedIds = new Set(assignments.map(({ id }) => id));
    let hasFrozenKeylessBefore = false;
    let hasAssignedBefore = false;
    for (const id of order) {
      const isFrozenKeyless = !writable.has(id) && keysById.get(id) == null;
      const isAssigned = assignedIds.has(id);
      if (
        (target.section === "active" && isFrozenKeyless && hasAssignedBefore) ||
        (target.section === "pinned" && isAssigned && hasFrozenKeylessBefore)
      ) {
        return null;
      }

      hasFrozenKeylessBefore ||= isFrozenKeyless;
      hasAssignedBefore ||= isAssigned;
    }

    return assignments;
  };
  switch (target.section) {
    case "active": {
      if (input.activeTimeOrdered) {
        return activeSection === "active"
          ? { kind: "none" }
          : {
              kind: "move-active",
              order: null,
              assignments: [],
              unpin: activePinned,
              unsettle: activeSettled,
              unsnooze: activeSection === "snoozed",
            };
      }
      const order = target.activeOrder;
      if (
        activeSection === "active" &&
        order.length === activeOrder.length &&
        order.every((key, index) => key === activeOrder[index])
      ) {
        return { kind: "none" };
      }
      const assignments = arrange(order, activeKeysById, activeReorderableKeys);
      if (assignments === null) return { kind: "none" };
      return {
        kind: "move-active",
        order,
        assignments,
        unpin: activePinned,
        unsettle: activeSettled,
        unsnooze: activeSection === "snoozed",
      };
    }
    case "settled":
      return activeSection === "settled" ? { kind: "none" } : { kind: "settle" };
    case "pinned": {
      const order = target.pinnedOrder;
      if (
        activeSection === "pinned" &&
        order.length === pinnedOrder.length &&
        order.every((key, index) => key === pinnedOrder[index])
      ) {
        return { kind: "none" };
      }
      const assignments = arrange(order, pinnedKeysById, reorderableKeys);
      if (assignments === null) return { kind: "none" };
      if (activeSection === "pinned") {
        return assignments.length === 0
          ? { kind: "none" }
          : { kind: "reorder-pinned", order, assignments };
      }
      return {
        kind: "pin",
        order,
        orderKey: assignments.find((assignment) => assignment.id === activeKey)?.orderKey,
        extraAssignments: activePinned
          ? assignments
          : assignments.filter((assignment) => assignment.id !== activeKey),
      };
    }
  }
}

export function applySidebarThreadDrop<
  T extends Pick<
    SidebarThreadSummary,
    | "pinnedAt"
    | "pinOrderKey"
    | "activeOrderKey"
    | "snoozedAt"
    | "snoozedUntil"
    | "settledAt"
    | "settledOverride"
    | "unsettledAt"
  >,
>(thread: T, section: "pinned" | "active" | "settled", now: string, orderKey?: string): T {
  const wasSettled = thread.settledOverride === "settled";
  const awake = { ...thread, snoozedAt: null, snoozedUntil: null };
  if (section === "settled") {
    return {
      ...awake,
      pinnedAt: null,
      pinOrderKey: null,
      activeOrderKey: null,
      settledOverride: "settled",
      settledAt: wasSettled ? (thread.settledAt ?? now) : now,
      unsettledAt: null,
    };
  }
  const resumed = wasSettled
    ? { ...awake, settledOverride: "active" as const, settledAt: null, unsettledAt: now }
    : awake;
  return {
    ...resumed,
    pinnedAt: section === "pinned" ? (thread.pinnedAt ?? now) : null,
    pinOrderKey: section === "pinned" ? (orderKey ?? thread.pinOrderKey) : null,
    ...(section === "active" && orderKey !== undefined ? { activeOrderKey: orderKey } : {}),
  };
}

export type SidebarProject = {
  id: string;
  title: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

export type ScopedSidebarProject = SidebarProject & {
  environmentId: string;
};

export type ScopedSidebarThread = ThreadSortInput & {
  environmentId: string;
  projectId: string;
  archivedAt: string | null;
};

export type LogicalSidebarProject = SidebarProject & {
  projectKey: string;
  memberProjectRefs: readonly {
    environmentId: string;
    projectId: string;
  }[];
};

export type ThreadTraversalDirection = "previous" | "next";

/** Exclude only successful deletions from shared-worktree checks. */
export async function deleteSelectedThreadEntries<
  TEntry extends { readonly threadKey: string },
>(input: {
  entries: readonly TEntry[];
  delete: (
    entry: TEntry,
    deletedThreadKeys: ReadonlySet<string>,
  ) => Promise<AtomCommandResult<unknown, unknown> | null>;
}) {
  const deletedThreadKeys = new Set<string>();
  let firstFailure: AsyncResult.Failure<unknown, unknown> | null = null;

  for (const entry of input.entries) {
    const result = await input.delete(entry, deletedThreadKeys);
    if (result === null) continue;
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) break;
      firstFailure ??= result;
      continue;
    }
    deletedThreadKeys.add(entry.threadKey);
  }

  return { deletedThreadKeys, firstFailure };
}

export function isSidebarHiddenThread(thread: Pick<SidebarThreadSummary, "lineage">): boolean {
  return !isListedThreadLineage(thread.lineage);
}

// Subagent and side-chat threads have no sidebar row, so an open one is represented by
// its nearest listed ancestor. A broken chain (missing parent, cycle,
// other environment) resolves to the thread itself, which then matches no row.
export function resolveSidebarRowThreadId(
  threadId: ThreadId,
  environmentId: EnvironmentId,
  threads: readonly Pick<SidebarThreadSummary, "id" | "environmentId" | "lineage">[],
): ThreadId {
  const findThread = (id: ThreadId) =>
    threads.find((thread) => thread.id === id && thread.environmentId === environmentId);
  const visited = new Set<ThreadId>();
  let thread = findThread(threadId);
  while (thread !== undefined && isSidebarHiddenThread(thread)) {
    if (thread.lineage.parentThreadId === null || visited.has(thread.id)) return threadId;
    visited.add(thread.id);
    thread = findThread(thread.lineage.parentThreadId);
  }
  return thread?.id ?? threadId;
}

/**
 * `delegatedUnderParent` holds the tasks linked environments run for a thread
 * the sidebar lists, by thread key; they show under that thread, as subagents do.
 */
export function filterSidebarV2VisibleThreads<
  T extends Pick<SidebarThreadSummary, "archivedAt" | "environmentId" | "id" | "lineage"> & {
    projectId: string;
  },
>(
  threads: readonly T[],
  scopedProjectKeys: ReadonlySet<string> | null,
  delegatedUnderParent: ReadonlySet<string>,
): T[] {
  return threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      !isShownUnderParent(
        { environmentId: thread.environmentId, threadId: thread.id },
        thread.lineage,
        delegatedUnderParent,
      ) &&
      (scopedProjectKeys === null ||
        scopedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`)),
  );
}

export function buildBulkTitleRegenerationContextMenuItem(input: {
  supportedCount: number;
  actionableCount: number;
}): ContextMenuItem<"regenerate-title"> | null {
  if (input.supportedCount === 0) return null;
  if (input.actionableCount === 0) {
    return {
      id: "regenerate-title",
      label: `Regenerating… (${input.supportedCount})`,
      disabled: true,
    };
  }
  return {
    id: "regenerate-title",
    label: `Regenerate titles (${input.actionableCount})`,
  };
}

export interface ThreadStatusPill {
  label:
    | "Working"
    | "Connecting"
    | "Completed"
    | "Failed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Guest Request"
    | "Waiting"
    | "Plan Ready";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

export type ThreadStatusInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "interactionMode"
  | "latestRun"
  | "runtime"
> & {
  lastVisitedAt?: string | null | undefined;
  pendingBackgroundTasks?: SidebarThreadSummary["pendingBackgroundTasks"] | undefined;
  blockedOnThreadWait?: boolean | undefined;
};

/**
 * Thread jump hints appear once the jump modifier has been held for a moment,
 * so a quick shortcut never flashes them, and hide as soon as it is released.
 */
