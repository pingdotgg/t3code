import {
  effectiveSettled,
  effectiveSnoozed,
  type ChangeRequestStateLike,
} from "@t3tools/client-runtime/state/thread-settled";
import type { OrchestrationThreadShell } from "@t3tools/contracts";

import type { BoardLane, BoardLaneId } from "../../board/boardLaneStore.ts";
import { isBoardFixedLaneId } from "../../board/boardLanes.ts";

export const BOARD_WORKFLOW_COLUMN_WIDTH = 380;

export type BoardThreadVisibility = "visible" | "archived" | "snoozed" | "settled";

/**
 * Lifecycle state stays server-backed and projects into its fixed board lane,
 * while local workflow placement survives underneath so a woken or
 * re-engaged thread returns to the same spatial slot.
 */
export function resolveBoardThreadVisibility(
  thread: OrchestrationThreadShell,
  options: {
    /** Exact wall clock for second-precise snooze wake boundaries. */
    readonly now: string;
    /** Minute-quantized clock shared with the sidebar's settlement partition. */
    readonly settlementNow: string;
    readonly autoSettleAfterDays: number | null;
    readonly supportsSettlement: boolean;
    readonly supportsSnooze: boolean;
    readonly changeRequestState: ChangeRequestStateLike | null;
  },
): BoardThreadVisibility {
  if (thread.archivedAt !== null) return "archived";

  // Snooze temporarily outranks pinning, matching the sidebar lifecycle.
  if (options.supportsSnooze && effectiveSnoozed(thread, { now: options.now })) {
    return "snoozed";
  }

  // Pinning protects a thread from automatic settlement. Explicit settle
  // clears pinning server-side, so a conflict here can only be stale/raced.
  if (thread.pinnedAt != null) return "visible";

  if (
    options.supportsSettlement &&
    effectiveSettled(thread, {
      now: options.settlementNow,
      autoSettleAfterDays: options.autoSettleAfterDays,
      changeRequestState: options.changeRequestState,
    })
  ) {
    return "settled";
  }

  return "visible";
}

/** Every local lane keeps its chosen width for the whole composed board. */
export function boardLaneGridTemplateColumns(
  columns: ReadonlyArray<{ readonly key: string; readonly laneId: BoardLaneId }>,
  laneWidthsByKey: Readonly<Record<string, number>> = {},
): string {
  return columns
    .map(({ key }) => `${laneWidthsByKey[key] ?? BOARD_WORKFLOW_COLUMN_WIDTH}px`)
    .join(" ");
}

export function boardProjectKey(environmentId: string, projectId: string): string {
  return `${environmentId}:${projectId}`;
}

export interface BoardThreadPlacement {
  readonly projectKey: string;
  readonly projectTitle: string;
  readonly laneColumnKey: string;
}

export interface ProjectSwimlane<T extends BoardThreadPlacement> {
  readonly projectKey: string;
  readonly projectTitle: string;
  readonly sessionCount: number;
  readonly entries: ReadonlyArray<T>;
}

export function groupEntriesByLane<T extends BoardThreadPlacement>(
  entries: ReadonlyArray<T>,
  laneColumnKeys: ReadonlyArray<string>,
): ReadonlyMap<string, ReadonlyArray<T>> {
  const map = new Map<string, Array<T>>();
  for (const key of laneColumnKeys) map.set(key, []);
  for (const entry of entries) map.get(entry.laneColumnKey)?.push(entry);
  return map;
}

export function buildProjectSwimlanes<T extends BoardThreadPlacement>(
  entries: ReadonlyArray<T>,
  projectScopeKey: string | null,
): ReadonlyArray<ProjectSwimlane<T>> {
  const filtered =
    projectScopeKey === null
      ? entries
      : entries.filter((entry) => entry.projectKey === projectScopeKey);

  const byProject = new Map<string, Array<T>>();
  for (const entry of filtered) {
    const list = byProject.get(entry.projectKey) ?? [];
    list.push(entry);
    byProject.set(entry.projectKey, list);
  }

  const swimlanes: Array<ProjectSwimlane<T>> = [];
  for (const [projectKey, projectEntries] of byProject) {
    swimlanes.push({
      projectKey,
      projectTitle: projectEntries[0]?.projectTitle ?? "Project",
      sessionCount: projectEntries.length,
      entries: projectEntries,
    });
  }

  return swimlanes.toSorted(
    (left, right) =>
      left.projectTitle.localeCompare(right.projectTitle, undefined, {
        sensitivity: "base",
        numeric: true,
      }) || left.projectKey.localeCompare(right.projectKey),
  );
}

export function shouldHideSwimlaneProjectHeader(projectScopeKey: string | null): boolean {
  return projectScopeKey !== null;
}

export function swimlaneColumnDroppableId(projectKey: string, laneColumnKey: string): string {
  return JSON.stringify(["board-swimlane", projectKey, laneColumnKey]);
}

export function boardLaneHeaderDroppableId(laneColumnKey: string): string {
  return swimlaneColumnDroppableId("board-lane-header", laneColumnKey);
}

export function laneColumnKeyFromSwimlaneDroppableId(droppableId: string): string | null {
  try {
    const parsed: unknown = JSON.parse(droppableId);
    if (
      Array.isArray(parsed) &&
      parsed[0] === "board-swimlane" &&
      typeof parsed[1] === "string" &&
      typeof parsed[2] === "string"
    ) {
      return parsed[2];
    }
  } catch {
    return null;
  }
  return null;
}

/** A local lane accepts cards from every connected environment. */
export function resolveBoardLaneDrop<
  Entry extends { readonly key: string; readonly laneColumnKey: string },
  Column extends { readonly key: string },
>(input: {
  readonly activeId: string;
  readonly overId: string;
  readonly entries: ReadonlyArray<Entry>;
  readonly columns: ReadonlyArray<Column>;
}): { readonly entry: Entry; readonly target: Column; readonly overEntry: Entry | null } | null {
  const entry = input.entries.find((candidate) => candidate.key === input.activeId);
  if (entry === undefined) return null;
  const overEntry = input.entries.find((candidate) => candidate.key === input.overId) ?? null;
  const laneColumnKey =
    overEntry?.laneColumnKey ?? laneColumnKeyFromSwimlaneDroppableId(input.overId);
  if (laneColumnKey === null) return null;
  const target = input.columns.find((column) => column.key === laneColumnKey);
  return target === undefined ? null : { entry, target, overEntry };
}

export function reorderBoardLaneKeys(input: {
  readonly orderedKeys: ReadonlyArray<string>;
  readonly activeKey: string;
  readonly overKey: string;
  readonly insertAfter: boolean;
}): ReadonlyArray<string> {
  const withoutActive = input.orderedKeys.filter((key) => key !== input.activeKey);
  const overIndex = withoutActive.indexOf(input.overKey);
  if (overIndex === -1) return input.orderedKeys;
  const insertionIndex = overIndex + (input.insertAfter ? 1 : 0);
  return [
    ...withoutActive.slice(0, insertionIndex),
    input.activeKey,
    ...withoutActive.slice(insertionIndex),
  ];
}

export interface BoardRect {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

export interface BoardScrollTarget {
  readonly top: number;
  readonly left: number;
}

/**
 * Centers a card inside the actually usable board viewport. Sticky lane and
 * project headers cover the top of the raw scroller rect, so scrollIntoView
 * can otherwise leave a card looking half-revealed even though the browser
 * considers it visible. Cards taller than the usable viewport align below
 * those headers; showing the whole card is physically impossible in that
 * case.
 */
export function resolveBoardScrollTarget(input: {
  readonly card: BoardRect;
  readonly viewport: BoardRect;
  readonly scrollTop: number;
  readonly scrollLeft: number;
}): BoardScrollTarget {
  const cardHeight = input.card.bottom - input.card.top;
  const viewportHeight = input.viewport.bottom - input.viewport.top;
  const top =
    cardHeight <= viewportHeight
      ? input.scrollTop +
        (input.card.top + input.card.bottom - input.viewport.top - input.viewport.bottom) / 2
      : input.scrollTop + input.card.top - input.viewport.top;
  const left =
    input.scrollLeft +
    (input.card.left + input.card.right - input.viewport.left - input.viewport.right) / 2;
  return { top: Math.max(0, top), left: Math.max(0, left) };
}

function visibleFraction(card: BoardRect, viewport: BoardRect): number {
  const axes = [
    [card.top, card.bottom, viewport.top, viewport.bottom],
    [card.left, card.right, viewport.left, viewport.right],
  ] as const;
  let smallest = 1;
  for (const [cardStart, cardEnd, viewStart, viewEnd] of axes) {
    const overlap = Math.min(cardEnd, viewEnd) - Math.max(cardStart, viewStart);
    const reference = Math.min(cardEnd - cardStart, viewEnd - viewStart);
    if (overlap <= 0 || reference <= 0) return 0;
    smallest = Math.min(smallest, overlap / reference);
  }
  return smallest;
}

export type BoardFocusAction = "reveal" | "open";

export function resolveBoardFocusAction(input: {
  readonly card: BoardRect | null;
  readonly viewport: BoardRect;
  readonly requestNonce: number;
  readonly acknowledgedRequestNonce: number | null;
}): BoardFocusAction {
  if (input.card === null) return "reveal";
  const focusWasAcknowledgedForPriorRequest =
    input.acknowledgedRequestNonce !== null && input.acknowledgedRequestNonce < input.requestNonce;
  return focusWasAcknowledgedForPriorRequest && visibleFraction(input.card, input.viewport) >= 0.9
    ? "open"
    : "reveal";
}

export type LaneArchiveIntent =
  | { readonly kind: "archive" }
  | { readonly kind: "confirm"; readonly memberCount: number; readonly explanation: string };

export function laneIdForName(name: string, lanes: ReadonlyArray<BoardLane>): BoardLaneId {
  const base =
    name
      .trim()
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "lane";
  const existingIds = new Set(lanes.map((lane) => lane.id));
  if (!existingIds.has(base)) return base;
  let suffix = 2;
  while (existingIds.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function nextLaneOrder(lanes: ReadonlyArray<BoardLane>): number {
  const editableLanes = lanes.filter((lane) => !isBoardFixedLaneId(lane.id));
  return editableLanes.length === 0 ? 0 : Math.max(...editableLanes.map((lane) => lane.order)) + 1;
}

export function reorderLaneUpdates(
  lanes: ReadonlyArray<BoardLane>,
  laneId: BoardLaneId,
  direction: "up" | "down",
): ReadonlyArray<{ readonly laneId: BoardLaneId; readonly order: number }> {
  const ordered = lanes
    .filter((lane) => !isBoardFixedLaneId(lane.id))
    .toSorted((left, right) => left.order - right.order || left.id.localeCompare(right.id));
  const laneIndex = ordered.findIndex((lane) => lane.id === laneId);
  const neighbourIndex = laneIndex + (direction === "up" ? -1 : 1);
  const lane = ordered[laneIndex];
  const neighbour = ordered[neighbourIndex];
  if (lane === undefined || neighbour === undefined) return [];
  return [
    { laneId: lane.id, order: neighbour.order },
    { laneId: neighbour.id, order: lane.order },
  ];
}

export function laneArchiveIntent(_laneId: BoardLaneId, memberCount: number): LaneArchiveIntent {
  if (memberCount > 0) {
    return {
      kind: "confirm",
      memberCount,
      explanation: `Archive this lane? Its ${memberCount} ${memberCount === 1 ? "session" : "sessions"} will return to the leftmost lane on this board.`,
    };
  }
  return { kind: "archive" };
}
