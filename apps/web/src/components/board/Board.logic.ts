import {
  canSettle,
  canSnooze,
  effectiveSettled,
  effectiveSnoozed,
} from "@t3tools/client-runtime/state/thread-settled";

import { resolveThreadStatusPill, sortThreadsForSidebar } from "../Sidebar.logic";
import type { SidebarThreadSummary } from "../../types";

/**
 * Board columns are derived, never stored: a thread has no user-settable
 * status, only the lifecycle flags the server owns. The order here is the
 * left-to-right order on screen — reordering the board is editing this array.
 */
export const BOARD_COLUMNS = [
  { id: "needs-you", label: "Needs You" },
  { id: "working", label: "Working" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
  { id: "idle", label: "Idle" },
  { id: "snoozed", label: "Snoozed" },
] as const;

export type BoardColumnId = (typeof BOARD_COLUMNS)[number]["id"];

/** The four columns a thread lands in while it is neither settled nor
    snoozed. Dropping onto any of them means the same thing (return to
    active), so they render as one merged drop region during such a drag. */
export const ACTIVE_BOARD_COLUMNS: ReadonlyArray<BoardColumnId> = [
  "needs-you",
  "working",
  "review",
  "idle",
];

export function isActiveBoardColumn(columnId: BoardColumnId): boolean {
  return ACTIVE_BOARD_COLUMNS.includes(columnId);
}

/** Per-environment server capabilities. A column whose command the server
    does not implement is hidden rather than shown with a failing drop: the
    user could neither move a card in nor move it back out. */
export interface BoardEnvironmentCapabilities {
  readonly settlement: boolean;
  readonly snooze: boolean;
  readonly pinning: boolean;
}

export interface BoardPartitionContext {
  /** Quantized to the minute by callers so `effectiveSettled` memoization
      does not churn; snooze classification passes a precise clock instead. */
  readonly now: string;
  readonly preciseNow: string;
  readonly autoSettleAfterDays: number | null;
  readonly capabilitiesFor: (thread: SidebarThreadSummary) => BoardEnvironmentCapabilities;
  readonly changeRequestStateFor: (
    thread: SidebarThreadSummary,
  ) => "open" | "closed" | "merged" | null;
  readonly lastVisitedAtFor: (thread: SidebarThreadSummary) => string | undefined;
}

/**
 * Mirrors the sidebar's partition (SidebarV2) exactly, so the two surfaces
 * can never disagree about where a thread belongs: snooze outranks a pin, a
 * pin suppresses auto-settle, and everything else splits by status pill.
 */
export function resolveBoardColumn(
  thread: SidebarThreadSummary,
  context: BoardPartitionContext,
): BoardColumnId {
  const capabilities = context.capabilitiesFor(thread);

  // Snooze outranks everything, including a pin: "hide until Tuesday"
  // temporarily suspends "keep on top".
  if (capabilities.snooze && effectiveSnoozed(thread, { now: context.preciseNow })) {
    return "snoozed";
  }

  // A pin otherwise overrides the lifecycle: pinned threads never auto-settle
  // out of sight, so they fall through to the active split below.
  const pinned = thread.pinnedAt != null;
  if (
    !pinned &&
    capabilities.settlement &&
    effectiveSettled(thread, {
      now: context.now,
      autoSettleAfterDays: context.autoSettleAfterDays,
      changeRequestState: context.changeRequestStateFor(thread),
    })
  ) {
    return "done";
  }

  return resolveActiveBoardColumn(thread, context.lastVisitedAtFor(thread));
}

/**
 * The active split. A failed session outranks the pill because the pill has
 * no error state and would report a stale Working for a thread whose
 * background fleet outlived the crash — same rule as resolveSidebarThreadStatus.
 */
export function resolveActiveBoardColumn(
  thread: SidebarThreadSummary,
  lastVisitedAt: string | undefined,
): BoardColumnId {
  if (thread.session?.status === "error") {
    return "needs-you";
  }

  const pill = resolveThreadStatusPill({ thread: { ...thread, lastVisitedAt } });
  if (pill === null) {
    return "idle";
  }

  switch (pill.label) {
    case "Pending Approval":
    case "Awaiting Input":
      return "needs-you";
    // Monitoring joins Working: for triage, "running but not blocked on you"
    // is one bucket. The card keeps the distinct pill so they read apart.
    case "Working":
    case "Connecting":
    case "Monitoring":
      return "working";
    case "Plan Ready":
    case "Completed":
      return "review";
  }
}

export type BoardColumns = Record<BoardColumnId, ReadonlyArray<SidebarThreadSummary>>;

function emptyColumns(): Record<BoardColumnId, SidebarThreadSummary[]> {
  return {
    "needs-you": [],
    working: [],
    review: [],
    done: [],
    idle: [],
    snoozed: [],
  };
}

/**
 * Archived threads never reach the board — archive keeps its "remove from
 * the list" meaning. Within a column, pinned cards sort first: a pin freezes
 * prominence, it does not introduce a new ordering scheme.
 */
export function partitionThreadsIntoBoardColumns(
  threads: ReadonlyArray<SidebarThreadSummary>,
  context: BoardPartitionContext,
): BoardColumns {
  const columns = emptyColumns();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    columns[resolveBoardColumn(thread, context)].push(thread);
  }

  const sorted = emptyColumns();
  for (const column of BOARD_COLUMNS) {
    sorted[column.id] = sortBoardColumnThreads(column.id, columns[column.id]);
  }
  return sorted;
}

function sortBoardColumnThreads(
  columnId: BoardColumnId,
  threads: ReadonlyArray<SidebarThreadSummary>,
): SidebarThreadSummary[] {
  // Soonest wake first: "what comes back next" is the shelf's question.
  if (columnId === "snoozed") {
    return [...threads].toSorted(
      (left, right) => snoozeWakeMs(left) - snoozeWakeMs(right) || left.id.localeCompare(right.id),
    );
  }
  const ordered = sortThreadsForSidebar(threads);
  return ordered.toSorted((left, right) => pinRank(left) - pinRank(right));
}

function pinRank(thread: SidebarThreadSummary): number {
  return thread.pinnedAt != null ? 0 : 1;
}

function snoozeWakeMs(thread: SidebarThreadSummary): number {
  const parsed = Date.parse(thread.snoozedUntil ?? "");
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

export type BoardDropKind = "settle" | "unsettle" | "snooze" | "unsnooze" | "none";

export interface BoardDropIntent {
  readonly kind: BoardDropKind;
  /** Why the drop is refused, shown as a column tooltip. Mirrors the wording
      of ThreadSettleBlockedError / ThreadSnoozeBlockedError so the board
      rejects before a round trip instead of firing a failing command. */
  readonly reason?: string;
}

const NO_DROP: BoardDropIntent = { kind: "none" };

/**
 * Only Done and Snoozed are writable, because only they have commands behind
 * them. Needs You / Working / Review / Idle are agent-owned: dropping between
 * them is a no-op, and dragging a settled or snoozed card onto any of them is
 * the single "return to active" move.
 */
export function resolveDropIntent(input: {
  readonly thread: SidebarThreadSummary;
  readonly from: BoardColumnId;
  readonly to: BoardColumnId;
  readonly capabilities: BoardEnvironmentCapabilities;
  readonly now: string;
}): BoardDropIntent {
  const { thread, from, to, capabilities, now } = input;
  if (from === to) return NO_DROP;

  if (to === "done") {
    if (!capabilities.settlement) {
      return { kind: "none", reason: "This environment's server does not support settling yet." };
    }
    if (!canSettle(thread, { now })) {
      return {
        kind: "none",
        reason: "This thread still needs attention. Resolve or interrupt it first, then try again.",
      };
    }
    return { kind: "settle" };
  }

  if (to === "snoozed") {
    if (!capabilities.snooze) {
      return { kind: "none", reason: "This environment's server does not support snoozing yet." };
    }
    if (!canSnooze(thread, { now })) {
      return {
        kind: "none",
        reason: "This thread is waiting on you. Respond to the pending request before snoozing it.",
      };
    }
    return { kind: "snooze" };
  }

  if (from === "done") {
    return capabilities.settlement
      ? { kind: "unsettle" }
      : { kind: "none", reason: "This environment's server does not support settling yet." };
  }

  if (from === "snoozed") {
    return capabilities.snooze
      ? { kind: "unsnooze" }
      : { kind: "none", reason: "This environment's server does not support snoozing yet." };
  }

  // Both ends are agent-owned. Nothing to write.
  return NO_DROP;
}

/**
 * Settling clears a pin server-side (the decider clears settled state on pin
 * and the pin on settle), so the badge disappearing must not be a surprise.
 */
export function dropHintForIntent(input: {
  readonly intent: BoardDropIntent;
  readonly thread: SidebarThreadSummary;
}): string | null {
  const { intent, thread } = input;
  switch (intent.kind) {
    case "settle":
      return thread.pinnedAt != null ? "Mark done — this also unpins the thread" : "Mark done";
    case "unsettle":
      return "Return to active";
    case "snooze":
      return "Snooze until…";
    case "unsnooze":
      return "Return to active";
    case "none":
      return intent.reason ?? null;
  }
}
