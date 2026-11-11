import * as Schema from "effect/Schema";

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

export type BoardPanelId =
  | "attention"
  | "working"
  | "failed"
  | "waiting"
  | "done"
  | "snoozed"
  | "settled";

export const BOARD_PANELS: ReadonlyArray<{ id: BoardPanelId; label: string }> = [
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

const PANEL_BY_STATUS: Record<SidebarThreadStatus, BoardPanelId> = {
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

function resolveBoardPanel(thread: BoardThread, now: string): BoardPanelId {
  if (thread.settledOverride === "settled") return "settled";
  if (effectiveSnoozed(thread, { now })) return "snoozed";
  return PANEL_BY_STATUS[resolveSidebarThreadStatus(thread)];
}

function timestampOf(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Pinned threads lead each panel, then the most recently updated. */
function compareBoardThreads(left: BoardThread, right: BoardThread): number {
  const pinned = Number(right.pinnedAt != null) - Number(left.pinnedAt != null);
  return pinned !== 0 ? pinned : timestampOf(right.updatedAt) - timestampOf(left.updatedAt);
}

export function groupThreadsByPanel<T extends BoardThread>(
  threads: ReadonlyArray<T>,
  now: string,
): Record<BoardPanelId, T[]> {
  const groups: Record<BoardPanelId, T[]> = {
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
    groups[resolveBoardPanel(thread, now)].push(thread);
  }
  for (const panel of BOARD_PANELS) groups[panel.id].sort(compareBoardThreads);
  return groups;
}

/** Columns left to right, each a stack of panels top to bottom. */
export interface BoardLayout {
  readonly columns: ReadonlyArray<ReadonlyArray<BoardPanelId>>;
  readonly collapsed: ReadonlyArray<BoardPanelId>;
}

export const BoardLayoutSchema = Schema.Struct({
  columns: Schema.Array(Schema.Array(Schema.String)),
  collapsed: Schema.Array(Schema.String),
});
export type SavedBoardLayout = typeof BoardLayoutSchema.Type;

export type BoardDropEdge = "left" | "right" | "top" | "bottom";

const isBoardPanelId = (id: string): id is BoardPanelId =>
  BOARD_PANELS.some((panel) => panel.id === id);

/** Drops unknown and repeated ids from a saved layout and adds missing panels as new columns. */
export function resolveBoardLayout(saved: SavedBoardLayout | null): BoardLayout {
  const seen = new Set<BoardPanelId>();
  const columns: BoardPanelId[][] = [];
  for (const savedColumn of saved?.columns ?? []) {
    const column: BoardPanelId[] = [];
    for (const id of savedColumn) {
      if (!isBoardPanelId(id) || seen.has(id)) continue;
      seen.add(id);
      column.push(id);
    }
    if (column.length > 0) columns.push(column);
  }
  for (const panel of BOARD_PANELS) {
    if (!seen.has(panel.id)) columns.push([panel.id]);
  }
  const collapsed = (saved?.collapsed ?? []).filter(isBoardPanelId);
  return { columns, collapsed: [...new Set(collapsed)] };
}

export function toggleBoardPanelCollapsed(layout: BoardLayout, id: BoardPanelId): BoardLayout {
  return {
    columns: layout.columns,
    collapsed: layout.collapsed.includes(id)
      ? layout.collapsed.filter((collapsedId) => collapsedId !== id)
      : [...layout.collapsed, id],
  };
}

/** Left and right open a new column beside the target; top and bottom stack into its column. */
export function moveBoardPanel(
  layout: BoardLayout,
  id: BoardPanelId,
  target: { readonly panelId: BoardPanelId; readonly edge: BoardDropEdge },
): BoardLayout {
  if (id === target.panelId) return layout;
  const columns = layout.columns
    .map((column) => column.filter((panelId) => panelId !== id))
    .filter((column) => column.length > 0);
  const columnIndex = columns.findIndex((column) => column.includes(target.panelId));
  if (columnIndex < 0) return layout;
  if (target.edge === "left" || target.edge === "right") {
    columns.splice(columnIndex + (target.edge === "right" ? 1 : 0), 0, [id]);
  } else {
    const column = [...columns[columnIndex]!];
    column.splice(column.indexOf(target.panelId) + (target.edge === "bottom" ? 1 : 0), 0, id);
    columns[columnIndex] = column;
  }
  return { columns, collapsed: layout.collapsed };
}

/** Outer quarters of a panel open a column beside it; the middle stacks above or below. */
export function resolveBoardDropEdge(
  rect: { left: number; top: number; width: number; height: number },
  point: { x: number; y: number },
): BoardDropEdge {
  const band = rect.width / 4;
  if (point.x < rect.left + band) return "left";
  if (point.x > rect.left + rect.width - band) return "right";
  return point.y < rect.top + rect.height / 2 ? "top" : "bottom";
}
