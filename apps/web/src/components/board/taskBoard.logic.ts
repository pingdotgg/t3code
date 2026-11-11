import {
  effectiveSnoozed,
  type ThreadSnoozeShell,
} from "@t3tools/client-runtime/state/thread-settled";

import type { SidebarThreadSummary } from "../../types";
import {
  isSidebarHiddenThread,
  resolveSidebarThreadStatus,
  type SidebarThreadStatus,
} from "../Sidebar.logic";

export type BoardColumnId =
  | "attention"
  | "working"
  | "failed"
  | "waiting"
  | "done"
  | "snoozed"
  | "settled";

export const BOARD_COLUMNS: ReadonlyArray<{ id: BoardColumnId; label: string }> = [
  { id: "attention", label: "Needs you" },
  { id: "working", label: "Working" },
  { id: "failed", label: "Failed" },
  { id: "waiting", label: "Waiting" },
  { id: "done", label: "Done" },
  { id: "snoozed", label: "Snoozed" },
  { id: "settled", label: "Settled" },
];

export type BoardThread = Pick<
  SidebarThreadSummary,
  | "lineage"
  | "archivedAt"
  | "settledOverride"
  | "pinnedAt"
  | "updatedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "runtime"
  | "blockedOnThreadWait"
> &
  ThreadSnoozeShell;

const COLUMN_BY_STATUS: Record<SidebarThreadStatus, BoardColumnId> = {
  approval: "attention",
  input: "attention",
  request: "attention",
  preparing: "working",
  working: "working",
  waiting: "waiting",
  failed: "failed",
  limited: "failed",
  ready: "done",
};

function resolveBoardColumn(thread: BoardThread, now: string): BoardColumnId {
  if (thread.settledOverride === "settled") return "settled";
  if (effectiveSnoozed(thread, { now })) return "snoozed";
  return COLUMN_BY_STATUS[resolveSidebarThreadStatus(thread)];
}

function timestampOf(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Pinned threads lead each column, then the most recently updated. */
function compareBoardThreads(left: BoardThread, right: BoardThread): number {
  const pinned = Number(right.pinnedAt != null) - Number(left.pinnedAt != null);
  return pinned !== 0 ? pinned : timestampOf(right.updatedAt) - timestampOf(left.updatedAt);
}

export function groupThreadsByColumn<T extends BoardThread>(
  threads: ReadonlyArray<T>,
  now: string,
): Record<BoardColumnId, T[]> {
  const groups: Record<BoardColumnId, T[]> = {
    attention: [],
    working: [],
    failed: [],
    waiting: [],
    done: [],
    snoozed: [],
    settled: [],
  };
  for (const thread of threads) {
    if (thread.archivedAt !== null || isSidebarHiddenThread(thread)) continue;
    groups[resolveBoardColumn(thread, now)].push(thread);
  }
  for (const column of BOARD_COLUMNS) groups[column.id].sort(compareBoardThreads);
  return groups;
}
