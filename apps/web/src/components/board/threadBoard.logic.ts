import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { resolveThreadActivityTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/client-runtime/thread-pull-requests";
import type { ScopedProjectRef } from "@t3tools/contracts";

import type { SidebarThreadSummary } from "../../types";
import { resolveSidebarRowStatus, type SidebarThreadStatus } from "../Sidebar.logic";

export type BoardLane = "needs" | "working" | "done";
export const BOARD_LANES: ReadonlyArray<BoardLane> = ["needs", "working", "done"];

export interface BoardLaneInput {
  readonly status: SidebarThreadStatus;
  /** A run is active; a "waiting" thread is then blocked on a child thread, not idle. */
  readonly runActive: boolean;
  readonly pullRequestChecksFailing: boolean;
}

/** Lanes come from state only (see fork/thread-board/VISION.md). */
export function resolveBoardLane(input: BoardLaneInput): BoardLane {
  switch (input.status) {
    case "approval":
    case "input":
    case "request":
    case "limited":
    case "failed":
      return "needs";
    case "preparing":
    case "working":
      return "working";
    case "waiting":
      return input.runActive ? "working" : "done";
    case "ready":
      return input.pullRequestChecksFailing ? "needs" : "done";
  }
}

export interface BoardCard {
  readonly thread: SidebarThreadSummary;
  readonly status: SidebarThreadStatus;
  readonly lane: BoardLane;
  readonly activityAt: string;
}

/** The thread's card, or null when it is off the board: settled or snoozed. */
export function resolveBoardCard(thread: SidebarThreadSummary, now: string): BoardCard | null {
  if (thread.settledOverride === "settled" || effectiveSnoozed(thread, { now })) return null;
  const status = resolveSidebarRowStatus(thread);
  const pullRequest = resolveThreadCurrentPullRequestLink(thread.pullRequests)?.snapshot ?? null;
  return {
    thread,
    status,
    lane: resolveBoardLane({
      status,
      runActive: thread.runtime?.status === "running",
      pullRequestChecksFailing:
        pullRequest?.state === "open" && pullRequest.checksState === "failing",
    }),
    activityAt: resolveThreadActivityTimestamp(thread) ?? thread.updatedAt,
  };
}

export interface BoardProjectGroup {
  readonly projectKey: string;
  readonly memberProjectRefs: ReadonlyArray<ScopedProjectRef>;
}

export interface BoardSwimlaneCard {
  readonly lane: BoardLane;
  readonly activityAt: string;
  readonly thread: Pick<SidebarThreadSummary, "environmentId" | "projectId">;
}

export interface BoardSwimlane<G, C> {
  readonly group: G;
  readonly lanes: Readonly<Record<BoardLane, ReadonlyArray<C>>>;
}

/**
 * One swimlane per project group that has cards. Projects with a card in Needs you come first,
 * the rest keep the given (sidebar) order. Needs you is a queue, oldest first; the other lanes
 * show the newest first.
 */
export function buildBoardSwimlanes<G extends BoardProjectGroup, C extends BoardSwimlaneCard>(
  groups: ReadonlyArray<G>,
  cards: ReadonlyArray<C>,
): ReadonlyArray<BoardSwimlane<G, C>> {
  const groupKeyByProject = new Map<string, string>();
  for (const group of groups) {
    for (const ref of group.memberProjectRefs) {
      groupKeyByProject.set(`${ref.environmentId}:${ref.projectId}`, group.projectKey);
    }
  }
  const lanesByGroup = new Map<string, Record<BoardLane, C[]>>();
  for (const card of cards) {
    const groupKey = groupKeyByProject.get(`${card.thread.environmentId}:${card.thread.projectId}`);
    if (groupKey === undefined) continue;
    let lanes = lanesByGroup.get(groupKey);
    if (lanes === undefined) {
      lanes = { needs: [], working: [], done: [] };
      lanesByGroup.set(groupKey, lanes);
    }
    lanes[card.lane].push(card);
  }
  const swimlanes: BoardSwimlane<G, C>[] = [];
  for (const group of groups) {
    const lanes = lanesByGroup.get(group.projectKey);
    if (lanes === undefined) continue;
    lanes.needs.sort((a, b) => compareActivity(a, b));
    lanes.working.sort((a, b) => compareActivity(b, a));
    lanes.done.sort((a, b) => compareActivity(b, a));
    swimlanes.push({ group, lanes });
  }
  return [
    ...swimlanes.filter((swimlane) => swimlane.lanes.needs.length > 0),
    ...swimlanes.filter((swimlane) => swimlane.lanes.needs.length === 0),
  ];
}

function compareActivity(a: BoardSwimlaneCard, b: BoardSwimlaneCard): number {
  return Date.parse(a.activityAt) - Date.parse(b.activityAt);
}

export type BoardArrowKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";

/**
 * The card an arrow key moves to. The grid is swimlanes × lanes of card keys. Up and down walk
 * one lane across swimlanes; left and right move to the nearest card of the next lane that has
 * one in the same swimlane. Null when there is nowhere to go.
 */
export function resolveBoardArrowTarget(
  grid: ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>>,
  current: string,
  key: BoardArrowKey,
): string | null {
  for (const [row, lanes] of grid.entries()) {
    for (const [lane, cards] of lanes.entries()) {
      const index = cards.indexOf(current);
      if (index === -1) continue;
      if (key === "ArrowDown") {
        if (index + 1 < cards.length) return cards[index + 1]!;
        for (const next of grid.slice(row + 1)) if (next[lane]?.length) return next[lane][0]!;
        return null;
      }
      if (key === "ArrowUp") {
        if (index > 0) return cards[index - 1]!;
        for (const previous of grid.slice(0, row).toReversed()) {
          const column = previous[lane];
          if (column?.length) return column[column.length - 1]!;
        }
        return null;
      }
      const step = key === "ArrowRight" ? 1 : -1;
      for (let column = lane + step; column >= 0 && column < lanes.length; column += step) {
        const target = lanes[column]!;
        if (target.length > 0) return target[Math.min(index, target.length - 1)]!;
      }
      return null;
    }
  }
  return null;
}
