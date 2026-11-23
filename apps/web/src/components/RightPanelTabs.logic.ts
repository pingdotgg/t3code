import {
  checkpointFileTotals,
  type ThreadCheckpointSummary,
} from "@t3tools/client-runtime/state/thread-checkpoints";
import type { TerminalSummary } from "@t3tools/contracts";

import type { RightPanelSurface, ThreadRightPanelState } from "~/rightPanelStore";
import { DEFAULT_THREAD_TERMINAL_HEIGHT } from "~/types";

export type RightPanelToolGroup =
  | "changes"
  | "browser"
  | "files"
  | "reviews"
  | "devices"
  | "threads";
export type RightPanelRailGroup = RightPanelToolGroup | "terminal";

const RIGHT_PANEL_TOOL_GROUPS: readonly RightPanelToolGroup[] = [
  "changes",
  "browser",
  "files",
  "reviews",
  "devices",
  "threads",
];

const GROUP_OF_KIND = {
  diff: "changes",
  preview: "browser",
  files: "files",
  file: "files",
  "pull-requests": "reviews",
  "pull-request": "reviews",
  issue: "reviews",
  device: "devices",
  thread: "threads",
  "linked-thread": "threads",
  terminal: "terminal",
} as const satisfies Record<RightPanelSurface["kind"], RightPanelRailGroup>;

export function rightPanelGroupOf(surface: RightPanelSurface): RightPanelRailGroup {
  return GROUP_OF_KIND[surface.kind];
}

/**
 * The surface a group's icon shows: the active one when it already belongs to the group, else
 * the newest of the group. Null means the group has none yet and must create one.
 */
export function rightPanelGroupTarget(
  surfaces: readonly RightPanelSurface[],
  activeSurfaceId: string | null,
  group: RightPanelToolGroup,
): RightPanelSurface | null {
  const active = surfaces.find((surface) => surface.id === activeSurfaceId);
  if (active && rightPanelGroupOf(active) === group) return active;
  return surfaces.findLast((surface) => rightPanelGroupOf(surface) === group) ?? null;
}

const ALWAYS_SHOWN_GROUPS = new Set<RightPanelToolGroup>(["changes", "browser", "files"]);

/** An open surface keeps its group on the rail, so nothing open becomes unreachable. */
export function visibleRightPanelToolGroups(input: {
  surfaces: readonly RightPanelSurface[];
  available: Readonly<Record<"reviews" | "devices" | "threads", boolean>>;
}): readonly RightPanelToolGroup[] {
  const present = new Set(input.surfaces.map(rightPanelGroupOf));
  return RIGHT_PANEL_TOOL_GROUPS.filter(
    (group) =>
      ALWAYS_SHOWN_GROUPS.has(group) ||
      present.has(group) ||
      input.available[group as "reviews" | "devices" | "threads"],
  );
}

type PanelVisibilityState = Pick<ThreadRightPanelState, "isOpen" | "activeSurfaceId" | "surfaces">;

export function visibleRightPanelGroups(
  state: PanelVisibilityState,
  drawerOpen: boolean,
): ReadonlySet<RightPanelRailGroup> {
  const visible = new Set<RightPanelRailGroup>();
  if (!state.isOpen) return visible;
  const active = state.surfaces.find((surface) => surface.id === state.activeSurfaceId);
  if (active && active.kind !== "terminal") visible.add(rightPanelGroupOf(active));
  if (drawerOpen) visible.add("terminal");
  return visible;
}

export function nextUnseenRightPanelGroups(input: {
  before: readonly RightPanelSurface[];
  after: PanelVisibilityState;
  drawerOpen: boolean;
  unseen: readonly RightPanelRailGroup[];
}): readonly RightPanelRailGroup[] {
  const visible = visibleRightPanelGroups(input.after, input.drawerOpen);
  const beforeIds = new Set(input.before.map((surface) => surface.id));
  const next = new Set(input.unseen.filter((group) => !visible.has(group)));
  for (const surface of input.after.surfaces) {
    if (beforeIds.has(surface.id)) continue;
    const group = rightPanelGroupOf(surface);
    if (!visible.has(group)) next.add(group);
  }
  if (next.size === input.unseen.length && input.unseen.every((group) => next.has(group))) {
    return input.unseen;
  }
  return [...next];
}

export function changesNovel(input: {
  latest: { turnCount: number; count: number } | null;
  seenTurnCount: number | undefined;
  changesVisible: boolean;
}): boolean {
  if (input.seenTurnCount === undefined || input.changesVisible) return false;
  return (
    input.latest !== null && input.latest.count > 0 && input.latest.turnCount > input.seenTurnCount
  );
}

export function latestTurnChangeTotals(
  summaries: ReadonlyArray<ThreadCheckpointSummary>,
): { turnCount: number; count: number; additions: number; deletions: number } | null {
  let latest: ThreadCheckpointSummary | undefined;
  for (const summary of summaries) {
    if (!latest || summary.checkpointTurnCount > latest.checkpointTurnCount) latest = summary;
  }
  if (!latest) return null;
  const totals = checkpointFileTotals(latest);
  return {
    turnCount: latest.checkpointTurnCount,
    count: totals.count,
    additions: totals.additions,
    deletions: totals.deletions,
  };
}

/**
 * Drops only follow a listing of the same snapshot, so a reconnect that briefly lists nothing
 * counts as a first observation and never takes a sub-tab away.
 */
export function reconcileTerminalSurfaceIds(input: {
  ownedIds: ReadonlySet<string>;
  serverIds: readonly string[];
  previous: { ids: readonly string[]; snapshotId: string | symbol | undefined } | undefined;
  snapshotId: string | symbol | undefined;
  closingIds: readonly string[];
}): { adopt: readonly string[]; drop: readonly string[] } {
  const closing = new Set(input.closingIds);
  const server = new Set(input.serverIds);
  const adopt = input.serverIds.filter((id) => !input.ownedIds.has(id) && !closing.has(id));
  const drop =
    input.previous === undefined || input.previous.snapshotId !== input.snapshotId
      ? []
      : input.previous.ids.filter((id) => !server.has(id) && input.ownedIds.has(id));
  return { adopt, drop };
}

export type TerminalSurfaceMount =
  | { readonly kind: "mount"; readonly terminalIds: string[] }
  | { readonly kind: "pending" }
  | { readonly kind: "ended" };

/**
 * Attaching to an id the server does not know starts a new shell, so a sub-tab mounts only ids
 * the server lists or that this client opened since the server last restarted.
 */
export function terminalSurfaceMount(input: {
  terminalIds: readonly string[];
  serverIds: readonly string[] | null;
  claimedIds: readonly string[];
}): TerminalSurfaceMount {
  const mountable = input.terminalIds.filter(
    (id) => input.serverIds?.includes(id) === true || input.claimedIds.includes(id),
  );
  if (mountable.length > 0) return { kind: "mount", terminalIds: mountable };
  return input.serverIds === null ? { kind: "pending" } : { kind: "ended" };
}

/**
 * Claims are cleared when the thread's reconcile sees a new server snapshot, which runs only
 * after a render; until then a list from a restarted server voids them.
 */
export function currentTerminalClaims(input: {
  claimedIds: readonly string[];
  observedSnapshotId: string | symbol | undefined;
  serverSnapshotId: string | symbol | undefined;
}): readonly string[] {
  return input.observedSnapshotId === undefined ||
    input.serverSnapshotId === undefined ||
    input.observedSnapshotId === input.serverSnapshotId
    ? input.claimedIds
    : [];
}

const MAX_HIDDEN_MOUNTED_TERMINAL_THREADS = 10;

/**
 * Threads whose drawer terminals stay mounted, least recently shown first: the active thread
 * once its drawer has shown, and other threads whose panel is still open, so switching back
 * does not re-attach and replay history.
 */
export function reconcileMountedTerminalThreads(input: {
  current: readonly string[];
  panelOpen: ReadonlySet<string>;
  active: string | null;
  activeShowing: boolean;
  maxHidden?: number;
}): string[] {
  const kept = input.current.filter(
    (key) => input.panelOpen.has(key) && !(key === input.active && input.activeShowing),
  );
  if (input.active !== null && input.activeShowing) kept.push(input.active);
  const maxHidden = input.maxHidden ?? MAX_HIDDEN_MOUNTED_TERMINAL_THREADS;
  let excess = kept.filter((key) => key !== input.active).length - maxHidden;
  return kept.filter((key) => key === input.active || excess-- <= 0);
}

export type TerminalDrawerStatus = "running" | "ok" | "failed";

export function terminalDrawerStatus(summary: TerminalSummary | null): TerminalDrawerStatus | null {
  if (!summary) return null;
  if (summary.status === "error" || (summary.exitCode !== null && summary.exitCode !== 0)) {
    return "failed";
  }
  if (summary.status === "exited" && summary.exitCode === 0) return "ok";
  if (
    (summary.status === "starting" || summary.status === "running") &&
    summary.hasRunningSubprocess
  ) {
    return "running";
  }
  return null;
}

export const TERMINAL_DRAWER_MIN_HEIGHT = 120;
export const TERMINAL_DRAWER_COLLAPSED_HEIGHT = 30;
const TERMINAL_DRAWER_TOOL_RESERVE = 120;

export function clampTerminalDrawerHeight(height: number, containerHeight: number): number {
  if (!Number.isFinite(height)) return DEFAULT_THREAD_TERMINAL_HEIGHT;
  const max = Math.max(TERMINAL_DRAWER_MIN_HEIGHT, containerHeight - TERMINAL_DRAWER_TOOL_RESERVE);
  return Math.min(Math.max(height, TERMINAL_DRAWER_MIN_HEIGHT), max);
}
