/** Layout functions stay pure and preserve identity on no-ops. Scoped tab keys permit multiple
 * environments; cameraWidth keeps long strips from reflowing. */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import type { ThreadRouteTarget } from "../threadRoutes";
import type { LayoutNewTabPosition, LayoutWhenNoRoom } from "./layoutBehavior";

/**
 * The two placements a thread's surfaces have shortcuts for, and whose sizes
 * the layout remembers: beside the chat (alt+cmd+B, "panel") and below it
 * (cmd+J, "terminal").
 */
export type LayoutCompanionKind = "panel" | "terminal";

/**
 * The surface id of a thread's terminal (cmd+J): its sessions and groups live
 * in `terminalUiStateStore`. Every other surface id names a `rightPanelStore`
 * surface of the thread.
 */
export const THREAD_TERMINAL_SURFACE_ID = "thread-terminal";
/**
 * A side pane saved before surfaces were tabs of their own. On load it turns
 * into its thread's surface tabs, in its place (see `surfaceSync.ts`).
 */
export const LEGACY_PANEL_SURFACE_ID = "legacy-panel";

/** Global pages become workspace tabs only when explicitly opened there. */
export type LayoutPageContent = { kind: "settings" | "usage" | "pull-requests"; href?: string };

export type LayoutTabContent =
  | { kind: "chat"; target: ThreadRouteTarget }
  | LayoutPageContent
  /**
   * An empty tab showing the launcher: start a thread, or open a surface for
   * `context`, the thread it was opened from (cmd+T, cmd+D, alt+cmd+B).
   * Picking a thread turns the tab into that chat; picking a surface replaces it.
   */
  | { kind: "launcher"; id: string; context: ThreadRouteTarget | null }
  /**
   * One surface of a thread (diff, files, a file, a browser, a terminal, a
   * pull request, a device), linked to the thread it works in but not owned
   * by its chat tab: it stays when the chat closes. What it shows lives in
   * `rightPanelStore` under `surfaceId`; `surfaceSync.ts` keeps the two in step.
   */
  | { kind: "surface"; threadRef: ScopedThreadRef; surfaceId: string };


export function isLayoutPageContent(content: LayoutTabContent): content is LayoutPageContent {
  return (
    content.kind === "settings" || content.kind === "usage" || content.kind === "pull-requests"
  );
}

export type LayoutLauncherContent = Extract<LayoutTabContent, { kind: "launcher" }>;
export type LayoutSurfaceContent = Extract<LayoutTabContent, { kind: "surface" }>;

export function createLayoutLauncherContent(
  context: ThreadRouteTarget | null,
): LayoutLauncherContent {
  return { kind: "launcher", id: createLayoutId("launcher"), context };
}

export interface LayoutTab {
  id: string;
  content: LayoutTabContent;
}

export interface LayoutPane {
  id: string;
  tabs: LayoutTab[];
  activeTabId: string | null;
  /** Share of the column's height; a column's panes sum to 1. */
  size: number;
}

export interface LayoutColumn {
  id: string;
  panes: LayoutPane[];
  /**
   * Width as a share of the strip its workspace was arranged at (niri's
   * proportion), 1 for full width. Neighbors never change it.
   */
  width: number;
}

export interface LayoutWorkspace {
  id: string;
  name: string | null;
  columns: LayoutColumn[];
  /** The pane that takes focus again when this workspace is revisited. */
  focusedPaneId: string | null;
  /**
   * The strip width in px the columns were last arranged at (opened, closed,
   * moved or resized). Resizing the window leaves it, so columns keep their
   * px widths and the window clips them. Null until the strip is measured.
   */
  cameraWidth: number | null;
}

export interface LayoutState {
  workspaces: LayoutWorkspace[];
  focusedWorkspaceId: string;
}

export interface LayoutTabLocation {
  workspace: LayoutWorkspace;
  column: LayoutColumn;
  pane: LayoutPane;
  tab: LayoutTab;
  tabIndex: number;
}

export type LayoutDirection = "left" | "right" | "up" | "down";

export type LayoutTabDestination =
  | { kind: "pane"; paneId: string; index?: number }
  | { kind: "split"; paneId: string; side: LayoutDirection }
  | { kind: "column"; workspaceId: string; index: number };

export type LayoutOpenPlacement = "active-pane" | "new-column" | "split-down";

export interface LayoutOpenOptions {
  placement?: LayoutOpenPlacement;
  position?: LayoutNewTabPosition;
}

/** The widths niri's switch-preset-column-width cycles through, full width last. */
export const LAYOUT_COLUMN_WIDTH_PRESETS = [1 / 3, 1 / 2, 2 / 3, 1] as const;
export const LAYOUT_MIN_COLUMN_WIDTH = 0.2;
/** A column dragged narrower than this stops being readable (pen uQRYP). */
export const LAYOUT_READABLE_COLUMN_PX = 420;
export const LAYOUT_MIN_PANE_SIZE = 0.1;

let idCounter = 0;
function createLayoutId(prefix: string): string {
  idCounter += 1;
  // Eight random hex digits plus a counter: unique per device, short in storage.
  const random = globalThis.crypto
    .getRandomValues(new Uint32Array(1))[0]!
    .toString(16)
    .padStart(8, "0");
  return `${prefix}:${random}${idCounter.toString(36)}`;
}

/** Two tabs with the same key show the same thing; opening one focuses the other. */
export function layoutTabContentKey(content: LayoutTabContent): string {
  if (content.kind === "chat") {
    return content.target.kind === "draft"
      ? `chat:draft:${content.target.draftId}`
      : `chat:${scopedThreadKey(content.target.threadRef)}`;
  }
  if (isLayoutPageContent(content)) return content.kind;
  if (content.kind === "launcher") return `launcher:${content.id}`;
  return `surface:${scopedThreadKey(content.threadRef)}:${content.surfaceId}`;
}

function createWorkspace(columns: LayoutColumn[] = []): LayoutWorkspace {
  return {
    id: createLayoutId("workspace"),
    name: null,
    columns,
    focusedPaneId: null,
    cameraWidth: null,
  };
}

function createPane(tab: LayoutTab, size = 1): LayoutPane {
  return { id: createLayoutId("pane"), tabs: [tab], activeTabId: tab.id, size };
}

function createColumn(pane: LayoutPane, width = 1): LayoutColumn {
  return { id: createLayoutId("column"), panes: [pane], width };
}

export function createLayoutTab(content: LayoutTabContent): LayoutTab {
  return { id: createLayoutId("tab"), content };
}

/** The default layout: one empty workspace, which the first opened tab fills. */
export function createLayoutState(): LayoutState {
  const workspace = createWorkspace();
  return { workspaces: [workspace], focusedWorkspaceId: workspace.id };
}

// Read selectors.

export function selectFocusedWorkspace(state: LayoutState): LayoutWorkspace {
  return (
    state.workspaces.find((workspace) => workspace.id === state.focusedWorkspaceId) ??
    state.workspaces[0]!
  );
}

export function selectFocusedPane(state: LayoutState): LayoutPane | null {
  const workspace = selectFocusedWorkspace(state);
  if (workspace.focusedPaneId === null) return null;
  for (const column of workspace.columns) {
    const pane = column.panes.find((candidate) => candidate.id === workspace.focusedPaneId);
    if (pane) return pane;
  }
  return null;
}

export function selectFocusedTab(state: LayoutState): LayoutTab | null {
  const pane = selectFocusedPane(state);
  if (!pane) return null;
  return pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? null;
}

export function findLayoutTab(
  state: LayoutState,
  predicate: (tab: LayoutTab) => boolean,
): LayoutTabLocation | null {
  for (const workspace of state.workspaces) {
    for (const column of workspace.columns) {
      for (const pane of column.panes) {
        const tabIndex = pane.tabs.findIndex(predicate);
        if (tabIndex !== -1) {
          return { workspace, column, pane, tab: pane.tabs[tabIndex]!, tabIndex };
        }
      }
    }
  }
  return null;
}

export function findLayoutTabByContent(
  state: LayoutState,
  content: LayoutTabContent,
): LayoutTabLocation | null {
  const key = layoutTabContentKey(content);
  return findLayoutTab(state, (tab) => layoutTabContentKey(tab.content) === key);
}

function findPane(
  state: LayoutState,
  paneId: string,
): { workspace: LayoutWorkspace; column: LayoutColumn; pane: LayoutPane } | null {
  for (const workspace of state.workspaces) {
    for (const column of workspace.columns) {
      const pane = column.panes.find((candidate) => candidate.id === paneId);
      if (pane) return { workspace, column, pane };
    }
  }
  return null;
}

/** Every chat target on screen: the active tab of each pane in the focused workspace. */
export function selectVisibleLayoutTabs(state: LayoutState): LayoutTab[] {
  return selectFocusedWorkspace(state).columns.flatMap((column) =>
    column.panes.flatMap((pane) => pane.tabs.filter((tab) => tab.id === pane.activeTabId)),
  );
}

export interface LayoutSlotRect {
  /** Fractions of the strip: left and width of the column, top and height of the pane. */
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface LayoutPaneSlot {
  paneId: string;
  activeTabId: string | null;
  rect: LayoutSlotRect;
  /** Neighbors, so the host can put gaps only between panes. */
  hasLeft: boolean;
  hasRight: boolean;
  hasAbove: boolean;
  hasBelow: boolean;
}

export interface LayoutViewport {
  /** The strip's visible width in px: the camera. */
  width: number;
  /** Settings › Layout › When there's no room: only always-shrink squashes columns. */
  whenNoRoom: LayoutWhenNoRoom;
}

/** Column shares remain independent. Short strips follow the viewport; long strips retain arranged
 * pixel widths and scroll instead of squeezing neighbors. */
export function selectLayoutPaneSlots(
  workspace: LayoutWorkspace,
  viewport: LayoutViewport,
): {
  slots: LayoutPaneSlot[];
  stripWidth: number;
  fits: boolean;
  unitWidth: number;
} {
  const lone = workspace.columns.length === 1;
  const weights = lone ? [1] : workspace.columns.map((column) => column.width);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const arranged = workspace.cameraWidth ?? viewport.width;
  let unitWidth: number;
  if (viewport.whenNoRoom === "always-shrink") {
    unitWidth = total > 0 ? viewport.width / total : viewport.width;
  } else if (total * arranged <= arranged + 0.5) {
    // The narrowest column stops at the readable width, or at the width it
    // was arranged at if that is narrower.
    const narrowest = Math.min(...weights);
    const readableUnit =
      lone || narrowest <= 0
        ? 0
        : Math.min(LAYOUT_READABLE_COLUMN_PX, narrowest * arranged) / narrowest;
    unitWidth = Math.max(viewport.width, readableUnit);
  } else {
    unitWidth = Math.max(arranged, viewport.width / total);
  }
  const totalPx = total * unitWidth;
  const fits = totalPx <= viewport.width + 0.5;
  const stripPx = Math.max(viewport.width, totalPx) || 1;
  const stripWidth = viewport.width > 0 ? stripPx / viewport.width : 1;
  const slots: LayoutPaneSlot[] = [];
  let left = 0;
  workspace.columns.forEach((column, columnIndex) => {
    let top = 0;
    const width = ((weights[columnIndex] ?? 0) * unitWidth) / stripPx;
    column.panes.forEach((pane, paneIndex) => {
      slots.push({
        paneId: pane.id,
        activeTabId: pane.activeTabId,
        rect: { left, top, width, height: pane.size },
        hasLeft: columnIndex > 0,
        hasRight: columnIndex < workspace.columns.length - 1,
        hasAbove: paneIndex > 0,
        hasBelow: paneIndex < column.panes.length - 1,
      });
      top += pane.size;
    });
    left += width;
  });
  return { slots, stripWidth, fits, unitWidth };
}

/** The pane with this id and where it sits, or null. */
export function findLayoutPane(
  state: LayoutState,
  paneId: string,
): { workspace: LayoutWorkspace; column: LayoutColumn; pane: LayoutPane } | null {
  return findPane(state, paneId);
}

/** How many tabs the layout holds across every workspace. */
export function countLayoutTabs(state: LayoutState): number {
  let count = 0;
  for (const workspace of state.workspaces) {
    for (const column of workspace.columns) {
      for (const pane of column.panes) count += pane.tabs.length;
    }
  }
  return count;
}

/**
 * The drafts open in chat tabs across every workspace. The composer draft
 * store keeps these alive, so "new tab" can open a second empty draft beside
 * one a tab still shows.
 */
export function layoutDraftIds(state: LayoutState): Set<string> {
  const ids = new Set<string>();
  for (const workspace of state.workspaces) {
    for (const column of workspace.columns) {
      for (const pane of column.panes) {
        for (const tab of pane.tabs) {
          if (tab.content.kind === "chat" && tab.content.target.kind === "draft") {
            ids.add(tab.content.target.draftId);
          }
        }
      }
    }
  }
  return ids;
}

/**
 * The focused tab and where it sits. Navigation swaps and new tabs anchor
 * here. (Before surfaces were tabs of their own this was the chat behind a
 * focused side pane; every tab now stands for itself.)
 */
export function selectFocusedChatTab(state: LayoutState): LayoutTabLocation | null {
  const focused = selectFocusedTab(state);
  if (!focused) return null;
  return findLayoutTab(state, (tab) => tab.id === focused.id);
}

/** The tab is the focused one: what a maximized pane may stay maximized for. */
export function isLayoutTabInFocusedGroup(state: LayoutState, tabId: string): boolean {
  return selectFocusedTab(state)?.id === tabId;
}

/** The launcher tab opened from this thread (alt+cmd+B's empty side pane), if any. */
export function findLayoutLauncherFor(
  state: LayoutState,
  target: ThreadRouteTarget,
): LayoutTabLocation | null {
  const key = layoutTabContentKey({ kind: "chat", target });
  return findLayoutTab(
    state,
    (tab) =>
      tab.content.kind === "launcher" &&
      tab.content.context !== null &&
      layoutTabContentKey({ kind: "chat", target: tab.content.context }) === key,
  );
}

/** Where a thread's surface tabs sit, in layout order. */
export function findLayoutSurfaceTabs(
  state: LayoutState,
  threadRef: ScopedThreadRef,
): LayoutTabLocation[] {
  const threadKey = scopedThreadKey(threadRef);
  const found: LayoutTabLocation[] = [];
  for (const workspace of state.workspaces) {
    for (const column of workspace.columns) {
      for (const pane of column.panes) {
        pane.tabs.forEach((tab, tabIndex) => {
          if (
            tab.content.kind === "surface" &&
            scopedThreadKey(tab.content.threadRef) === threadKey
          ) {
            found.push({ workspace, column, pane, tab, tabIndex });
          }
        });
      }
    }
  }
  return found;
}

/** The chat tab showing this thread, if any (a server thread, or the draft it was promoted from). */
export function findLayoutChatForThread(
  state: LayoutState,
  threadRef: ScopedThreadRef,
  draftId: string | null = null,
): LayoutTabLocation | null {
  const threadKey = scopedThreadKey(threadRef);
  return findLayoutTab(
    state,
    (tab) =>
      tab.content.kind === "chat" &&
      (tab.content.target.kind === "server"
        ? scopedThreadKey(tab.content.target.threadRef) === threadKey
        : tab.content.target.draftId === draftId),
  );
}

// Immutable layout helpers.

function mapWorkspaces(
  state: LayoutState,
  update: (workspace: LayoutWorkspace) => LayoutWorkspace,
): LayoutState {
  let changed = false;
  const workspaces = state.workspaces.map((workspace) => {
    const next = update(workspace);
    if (next !== workspace) changed = true;
    return next;
  });
  return changed ? { ...state, workspaces } : state;
}

function mapPanes(state: LayoutState, update: (pane: LayoutPane) => LayoutPane): LayoutState {
  return mapWorkspaces(state, (workspace) => {
    let workspaceChanged = false;
    const columns = workspace.columns.map((column) => {
      let columnChanged = false;
      const panes = column.panes.map((pane) => {
        const next = update(pane);
        if (next !== pane) columnChanged = true;
        return next;
      });
      if (!columnChanged) return column;
      workspaceChanged = true;
      return { ...column, panes };
    });
    return workspaceChanged ? { ...workspace, columns } : workspace;
  });
}

function scaleToOne<T extends { size: number }>(items: T[]): T[] {
  const total = items.reduce((sum, item) => sum + item.size, 0);
  if (items.length === 0 || Math.abs(total - 1) < 1e-6) return items;
  if (total <= 0) return items.map((item) => ({ ...item, size: 1 / items.length }));
  return items.map((item) => ({ ...item, size: item.size / total }));
}

/**
 * Restore the model's invariants: no empty panes or columns, pane sizes sum
 * to 1, valid active tabs and focus, and exactly one empty workspace at the
 * bottom. An empty workspace that is focused survives until focus leaves it.
 */
function normalizeLayout(state: LayoutState): LayoutState {
  let workspaces = state.workspaces.map((workspace) => {
    let changed = false;
    const keptColumns = workspace.columns.flatMap((column) => {
      const kept = column.panes.flatMap((pane) => {
        if (pane.tabs.length === 0) return [];
        if (pane.activeTabId !== null && pane.tabs.some((tab) => tab.id === pane.activeTabId)) {
          return [pane];
        }
        return [{ ...pane, activeTabId: pane.tabs[0]!.id }];
      });
      if (kept.length === 0) {
        changed = true;
        return [];
      }
      const panes = scaleToOne(kept);
      if (
        panes.length === column.panes.length &&
        panes.every((pane, i) => pane === column.panes[i])
      ) {
        return [column];
      }
      changed = true;
      return [{ ...column, panes }];
    });
    const columns = keptColumns;
    const paneIds = columns.flatMap((column) => column.panes.map((pane) => pane.id));
    const focusedPaneId =
      workspace.focusedPaneId !== null && paneIds.includes(workspace.focusedPaneId)
        ? workspace.focusedPaneId
        : (paneIds[0] ?? null);
    if (!changed && focusedPaneId === workspace.focusedPaneId) return workspace;
    return { ...workspace, columns, focusedPaneId };
  });

  workspaces = workspaces.filter(
    (workspace, index) =>
      workspace.columns.length > 0 ||
      workspace.id === state.focusedWorkspaceId ||
      index === workspaces.length - 1,
  );
  // Drop an empty, unfocused workspace that sits right above the trailing one.
  while (
    workspaces.length > 1 &&
    workspaces.at(-1)!.columns.length === 0 &&
    workspaces.at(-2)!.columns.length === 0 &&
    workspaces.at(-2)!.id !== state.focusedWorkspaceId
  ) {
    workspaces.splice(workspaces.length - 2, 1);
  }
  // A focused empty workspace right above the trailing one stands in for it:
  // closing everything leaves one empty workspace, not two.
  if (
    workspaces.length > 1 &&
    workspaces.at(-1)!.columns.length === 0 &&
    workspaces.at(-2)!.columns.length === 0 &&
    workspaces.at(-2)!.id === state.focusedWorkspaceId
  ) {
    workspaces.splice(workspaces.length - 1, 1);
  }
  if (workspaces.length === 0 || workspaces.at(-1)!.columns.length > 0) {
    workspaces.push(createWorkspace());
  }
  const focusedWorkspaceId = workspaces.some(
    (workspace) => workspace.id === state.focusedWorkspaceId,
  )
    ? state.focusedWorkspaceId
    : workspaces[0]!.id;

  const unchanged =
    focusedWorkspaceId === state.focusedWorkspaceId &&
    workspaces.length === state.workspaces.length &&
    workspaces.every((workspace, index) => workspace === state.workspaces[index]);
  return unchanged ? state : { workspaces, focusedWorkspaceId };
}

/**
 * Pin only changed workspaces to the current camera width.
 * Unchanged workspaces retain geometry across window resizes and column reordering.
 */
export function arrangeLayoutWorkspaces(
  before: LayoutState,
  after: LayoutState,
  cameraWidth: number,
): LayoutState {
  if (cameraWidth <= 0) return after;
  return mapWorkspaces(after, (workspace) => {
    if (workspace.columns.length === 0 || workspace.cameraWidth === cameraWidth) return workspace;
    const previous = before.workspaces.find((candidate) => candidate.id === workspace.id);
    const unchanged =
      workspace.cameraWidth !== null &&
      previous !== undefined &&
      previous.columns.length === workspace.columns.length &&
      workspace.columns.every((column) =>
        previous.columns.some(
          (candidate) => candidate.id === column.id && candidate.width === column.width,
        ),
      );
    return unchanged ? workspace : { ...workspace, cameraWidth };
  });
}

/** Only opening or closing columns triggers fitting. Temporary side panes borrow and return their
 * chat column share; reordering preserves widths. */
export function fitLayoutColumns(
  before: LayoutState,
  after: LayoutState,
  mode: LayoutWhenNoRoom,
  viewportPx: number,
): LayoutState {
  if (viewportPx <= 0) return after;
  const floor =
    mode === "always-shrink"
      ? 0
      : Math.max(
          LAYOUT_MIN_COLUMN_WIDTH,
          mode === "shrink-then-scroll" ? LAYOUT_READABLE_COLUMN_PX / viewportPx : 0,
        );
  return mapWorkspaces(after, (workspace) => {
    const previous = before.workspaces.find((candidate) => candidate.id === workspace.id);
    const previousIds = new Set(previous?.columns.map((column) => column.id));
    const ids = new Set(workspace.columns.map((column) => column.id));
    const added = workspace.columns.filter((column) => !previousIds.has(column.id));
    const removed = previous?.columns.filter((column) => !ids.has(column.id)) ?? [];
    if (added.length === 0 && removed.length === 0) return workspace;
    const widths = new Map(workspace.columns.map((column) => [column.id, column.width]));
    if (workspace.columns.length === 1) {
      widths.set(workspace.columns[0]!.id, 1);
    } else {
      // A lone column was filling the window, whatever its stored width.
      const lone = previous?.columns.length === 1 ? previous.columns[0]!.id : null;
      if (lone !== null && widths.has(lone)) widths.set(lone, 1);
      // A new column takes the others' average width, so equal columns stay equal.
      const kept = workspace.columns.filter((column) => previousIds.has(column.id));
      const average =
        kept.length > 0
          ? kept.reduce((sum, column) => sum + widths.get(column.id)!, 0) / kept.length
          : 1;
      for (const column of added) {
        widths.set(column.id, mode === "always-scroll" ? column.width : average);
      }
      if (mode !== "always-scroll") {
        const total = [...widths.values()].reduce((sum, width) => sum + width, 0);
        // Shrink to share the window; after a close, grow back to fill it.
        const scale = total > 1 || removed.length > 0 ? 1 / total : 1;
        for (const [id, width] of widths) widths.set(id, Math.max(floor, width * scale));
      }
    }
    const columns = workspace.columns.map((column) => {
      const width = widths.get(column.id)!;
      return Math.abs(width - column.width) < 1e-4 ? column : { ...column, width };
    });
    return columns.every((column, index) => column === workspace.columns[index])
      ? workspace
      : { ...workspace, columns };
  });
}

// Focus changes.

export function focusLayoutPane(state: LayoutState, paneId: string): LayoutState {
  const found = findPane(state, paneId);
  if (!found) return state;
  if (found.workspace.id === state.focusedWorkspaceId && found.workspace.focusedPaneId === paneId) {
    return state;
  }
  return normalizeLayout({
    ...mapWorkspaces(state, (workspace) =>
      workspace.id === found.workspace.id ? { ...workspace, focusedPaneId: paneId } : workspace,
    ),
    focusedWorkspaceId: found.workspace.id,
  });
}

export function focusLayoutTab(state: LayoutState, tabId: string): LayoutState {
  const location = findLayoutTab(state, (tab) => tab.id === tabId);
  if (!location) return state;
  const activated = mapPanes(state, (pane) =>
    pane.id === location.pane.id && pane.activeTabId !== tabId
      ? { ...pane, activeTabId: tabId }
      : pane,
  );
  return focusLayoutPane(activated, location.pane.id);
}

export function focusLayoutWorkspace(state: LayoutState, workspaceId: string): LayoutState {
  if (state.focusedWorkspaceId === workspaceId) return state;
  if (!state.workspaces.some((workspace) => workspace.id === workspaceId)) return state;
  return normalizeLayout({ ...state, focusedWorkspaceId: workspaceId });
}

/** Move focus to the neighboring pane, column, or workspace. */
export function focusLayoutDirection(state: LayoutState, direction: LayoutDirection): LayoutState {
  const workspace = selectFocusedWorkspace(state);
  const columnIndex = workspace.columns.findIndex((column) =>
    column.panes.some((pane) => pane.id === workspace.focusedPaneId),
  );
  const column = workspace.columns[columnIndex];
  const paneIndex = column?.panes.findIndex((pane) => pane.id === workspace.focusedPaneId) ?? -1;

  if (direction === "left" || direction === "right") {
    const nextColumn = workspace.columns[columnIndex + (direction === "left" ? -1 : 1)];
    if (!column || !nextColumn) return state;
    const nextPane = nextColumn.panes[Math.min(paneIndex, nextColumn.panes.length - 1)]!;
    return focusLayoutPane(state, nextPane.id);
  }

  const nextPane = column?.panes[paneIndex + (direction === "up" ? -1 : 1)];
  if (nextPane) return focusLayoutPane(state, nextPane.id);
  return focusLayoutWorkspaceStep(state, direction === "up" ? -1 : 1);
}

// Keyboard map (niri's, see layoutCommands.ts).

interface LayoutFocusedLocation {
  workspace: LayoutWorkspace;
  workspaceIndex: number;
  column: LayoutColumn;
  columnIndex: number;
  pane: LayoutPane;
  paneIndex: number;
}

function locateFocusedPane(state: LayoutState): LayoutFocusedLocation | null {
  const workspace = selectFocusedWorkspace(state);
  const columnIndex = workspace.columns.findIndex((column) =>
    column.panes.some((pane) => pane.id === workspace.focusedPaneId),
  );
  const column = workspace.columns[columnIndex];
  if (!column) return null;
  const paneIndex = column.panes.findIndex((pane) => pane.id === workspace.focusedPaneId);
  return {
    workspace,
    workspaceIndex: state.workspaces.indexOf(workspace),
    column,
    columnIndex,
    pane: column.panes[paneIndex]!,
    paneIndex,
  };
}

function replaceWorkspaceColumns(
  state: LayoutState,
  workspaceId: string,
  columns: LayoutColumn[],
): LayoutState {
  return mapWorkspaces(state, (workspace) =>
    workspace.id === workspaceId ? { ...workspace, columns } : workspace,
  );
}

/** Focus the first or last column of the focused workspace (alt+cmd+Home / End). */
export function focusLayoutColumnEdge(state: LayoutState, edge: "first" | "last"): LayoutState {
  const found = locateFocusedPane(state);
  if (!found) return state;
  const column = edge === "first" ? found.workspace.columns[0] : found.workspace.columns.at(-1);
  if (!column || column.id === found.column.id) return state;
  const pane = column.panes[Math.min(found.paneIndex, column.panes.length - 1)]!;
  return focusLayoutPane(state, pane.id);
}

/**
 * Move the focused pane's column left or right past its neighbor, or the
 * focused pane up or down within its column; focus travels with it. Past
 * the first or last column, a pane that shares its column (or a tab that
 * shares its pane) moves into a new column there; a lone column stays.
 */
export function moveLayoutFocused(state: LayoutState, direction: LayoutDirection): LayoutState {
  const found = locateFocusedPane(state);
  if (!found) return state;
  const { workspace, column, columnIndex, pane, paneIndex } = found;

  if (direction === "up" || direction === "down") {
    const otherIndex = paneIndex + (direction === "up" ? -1 : 1);
    const other = column.panes[otherIndex];
    if (!other) return state;
    const panes = [...column.panes];
    panes[paneIndex] = other;
    panes[otherIndex] = pane;
    return replaceWorkspaceColumns(
      state,
      workspace.id,
      workspace.columns.map((candidate) =>
        candidate.id === column.id ? { ...candidate, panes } : candidate,
      ),
    );
  }

  const otherIndex = columnIndex + (direction === "left" ? -1 : 1);
  const other = workspace.columns[otherIndex];
  if (other) {
    const columns = [...workspace.columns];
    columns[columnIndex] = other;
    columns[otherIndex] = column;
    return replaceWorkspaceColumns(state, workspace.id, columns);
  }
  if (column.panes.length === 1 && pane.tabs.length === 1) return state;
  const tab = pane.tabs.find((candidate) => candidate.id === pane.activeTabId);
  if (!tab) return state;
  return moveLayoutTab(state, tab.id, {
    kind: "column",
    workspaceId: workspace.id,
    index: direction === "left" ? 0 : workspace.columns.length,
  });
}

/**
 * Pull the focused pane in or out of a column (alt+cmd+[ / ]): a pane that
 * shares its column leaves it for a new column on that side; a pane alone in
 * its column joins the neighboring column on that side, at the bottom.
 */
export function pullLayoutPane(state: LayoutState, side: "left" | "right"): LayoutState {
  const found = locateFocusedPane(state);
  if (!found) return state;
  const { workspace, column, columnIndex, pane } = found;

  // As in niri, the expelled pane's column takes its old column's width.
  if (column.panes.length > 1) {
    const remaining = column.panes.filter((candidate) => candidate.id !== pane.id);
    const columns = workspace.columns.flatMap((candidate) => {
      if (candidate.id !== column.id) return [candidate];
      const kept = { ...candidate, panes: scaleToOne(remaining) };
      const expelled = createColumn({ ...pane, size: 1 }, column.width);
      return side === "left" ? [expelled, kept] : [kept, expelled];
    });
    return normalizeLayout(replaceWorkspaceColumns(state, workspace.id, columns));
  }

  const neighbor = workspace.columns[columnIndex + (side === "left" ? -1 : 1)];
  if (!neighbor) return state;
  const joined = neighbor.panes.length + 1;
  const panes = [
    ...neighbor.panes.map((candidate) => ({
      ...candidate,
      size: (candidate.size * (joined - 1)) / joined,
    })),
    { ...pane, size: 1 / joined },
  ];
  const columns = workspace.columns.flatMap((candidate) => {
    if (candidate.id === column.id) return [];
    return candidate.id === neighbor.id ? [{ ...candidate, panes }] : [candidate];
  });
  return normalizeLayout(replaceWorkspaceColumns(state, workspace.id, columns));
}

/**
 * Focus the workspace below (1) or above (-1), niri's alt+cmd+U / I. Below
 * the last is always the empty one; above the first, an empty one opens,
 * unless the first is already empty.
 */
export function focusLayoutWorkspaceStep(state: LayoutState, delta: 1 | -1): LayoutState {
  const workspace = selectFocusedWorkspace(state);
  const index = state.workspaces.indexOf(workspace);
  const next = state.workspaces[index + delta];
  if (next) return focusLayoutWorkspace(state, next.id);
  if (delta === 1 || workspace.columns.length === 0) return state;
  const empty = createWorkspace();
  return normalizeLayout({
    workspaces: [empty, ...state.workspaces],
    focusedWorkspaceId: empty.id,
  });
}

/**
 * Move the focused tab to the end of the workspace below or above; focus
 * follows. Below the last
 * workspace is the empty one, so this is also how a thread gets a new
 * workspace of its own.
 */
export function moveLayoutTabToWorkspace(state: LayoutState, delta: 1 | -1): LayoutState {
  const chat = selectFocusedChatTab(state);
  if (!chat) return state;
  const index = state.workspaces.indexOf(chat.workspace);
  const target = state.workspaces[index + delta];
  if (!target) return state;
  // A workspace's only chat moving into the empty one would just trade places.
  const tabsInWorkspace = chat.workspace.columns
    .flatMap((column) => column.panes)
    .flatMap((pane) => pane.tabs).length;
  if (tabsInWorkspace === 1 && target.columns.length === 0) return state;
  return moveLayoutTab(state, chat.tab.id, {
    kind: "column",
    workspaceId: target.id,
    index: target.columns.length,
  });
}

/**
 * Move a tab into a new workspace of its own,
 * inserted at `index` of the stack (the overview's "New workspace" line).
 * Focus follows. The trailing empty workspace stays at the bottom.
 */
export function moveLayoutTabToNewWorkspace(
  state: LayoutState,
  tabId: string,
  index: number,
  name: string | null = null,
): LayoutState {
  const location = findLayoutTab(state, (tab) => tab.id === tabId);
  if (!location) return state;
  // A workspace's only tab, just above or below its own row, would only trade
  // its workspace for an unnamed one.
  const sourceIndex = state.workspaces.indexOf(location.workspace);
  const alone =
    location.workspace.columns.flatMap((column) => column.panes).flatMap((pane) => pane.tabs)
      .length === 1;
  if (alone && name === null && (index === sourceIndex || index === sourceIndex + 1)) {
    return state;
  }
  const workspace: LayoutWorkspace = { ...createWorkspace(), name };
  const workspaces = [...state.workspaces];
  // Never below the trailing empty workspace.
  workspaces.splice(Math.max(0, Math.min(index, workspaces.length - 1)), 0, workspace);
  const withWorkspace = { ...state, workspaces };
  const moved = moveLayoutTab(withWorkspace, tabId, {
    kind: "column",
    workspaceId: workspace.id,
    index: 0,
  });
  return moved === withWorkspace ? state : moved;
}

/**
 * Move a tab into a new column at `index` of a workspace (the overview's
 * insert line). Focus follows.
 */
export function moveLayoutChatToColumn(
  state: LayoutState,
  tabId: string,
  workspaceId: string,
  index: number,
): LayoutState {
  const location = findLayoutTab(state, (tab) => tab.id === tabId);
  if (!location) return state;
  const alone = location.column.panes.length === 1 && location.pane.tabs.length === 1;
  const columnIndex = location.workspace.columns.indexOf(location.column);
  // Dropping a lone column right beside itself changes nothing.
  if (
    alone &&
    location.workspace.id === workspaceId &&
    (index === columnIndex || index === columnIndex + 1)
  ) {
    return state;
  }
  return moveLayoutTab(state, tabId, { kind: "column", workspaceId, index });
}

/**
 * Show a chat in a workspace of its own at the bottom of the stack: move
 * the tab already showing it there, or open a new tab there. How a pull
 * request gets its own workspace (chat with its terminal and PR panel).
 */
export function showLayoutChatInNewWorkspace(
  state: LayoutState,
  content: Extract<LayoutTabContent, { kind: "chat" }>,
  name: string | null,
): LayoutState {
  const existing = findLayoutTabByContent(state, content);
  if (existing) {
    const chatsInWorkspace = existing.workspace.columns
      .flatMap((column) => column.panes)
      .flatMap((pane) => pane.tabs)
      .filter((tab) => tab.content.kind === "chat").length;
    // Already a workspace of its own: go there and name it.
    if (chatsInWorkspace === 1) {
      const renamed =
        name === null ? state : renameLayoutWorkspace(state, existing.workspace.id, name);
      return focusLayoutTab(renamed, existing.tab.id);
    }
    return moveLayoutTabToNewWorkspace(state, existing.tab.id, state.workspaces.length - 1, name);
  }
  const trailing = state.workspaces.at(-1)!;
  const named = name === null ? state : renameLayoutWorkspace(state, trailing.id, name);
  return insertColumn(named, trailing.id, 0, createColumn(createPane(createLayoutTab(content))));
}

/** Name a workspace; an empty name falls back to its first thread's title. */
export function renameLayoutWorkspace(
  state: LayoutState,
  workspaceId: string,
  name: string | null,
): LayoutState {
  const trimmed = name?.trim() || null;
  return mapWorkspaces(state, (workspace) =>
    workspace.id === workspaceId && workspace.name !== trimmed
      ? { ...workspace, name: trimmed }
      : workspace,
  );
}

/** The chat tab a workspace is named after when it has no name of its own. */
export function selectLayoutWorkspaceLeadTab(workspace: LayoutWorkspace): LayoutTab | null {
  for (const column of workspace.columns) {
    for (const pane of column.panes) {
      const tab =
        pane.tabs.find((candidate) => candidate.id === pane.activeTabId) ?? pane.tabs[0] ?? null;
      if (tab?.content.kind === "chat") return tab;
    }
  }
  return null;
}

/** Scoped keys of every server thread a chat tab holds, in any workspace, sorted. */
export function selectLayoutThreadKeys(state: LayoutState): string[] {
  const keys: string[] = [];
  for (const workspace of state.workspaces) {
    for (const column of workspace.columns) {
      for (const pane of column.panes) {
        for (const tab of pane.tabs) {
          if (tab.content.kind === "chat" && tab.content.target.kind === "server") {
            keys.push(scopedThreadKey(tab.content.target.threadRef));
          }
        }
      }
    }
  }
  return keys.toSorted();
}

/**
 * Swap the focused workspace with the one below (1) or above (-1). The empty
 * workspace always stays at the bottom.
 */
export function moveLayoutWorkspace(state: LayoutState, delta: 1 | -1): LayoutState {
  const workspace = selectFocusedWorkspace(state);
  const index = state.workspaces.indexOf(workspace);
  const otherIndex = index + delta;
  const other = state.workspaces[otherIndex];
  if (!other || workspace.columns.length === 0 || other.columns.length === 0) return state;
  const workspaces = [...state.workspaces];
  workspaces[index] = other;
  workspaces[otherIndex] = workspace;
  return { ...state, workspaces };
}

// Tab operations.

function insertTabIntoPane(
  state: LayoutState,
  paneId: string,
  tab: LayoutTab,
  index: number | "after-current" | "end",
): LayoutState {
  const inserted = mapPanes(state, (pane) => {
    if (pane.id !== paneId) return pane;
    const tabs = [...pane.tabs];
    const at =
      index === "end"
        ? tabs.length
        : index === "after-current"
          ? tabs.findIndex((candidate) => candidate.id === pane.activeTabId) + 1 || tabs.length
          : Math.max(0, Math.min(index, tabs.length));
    tabs.splice(at, 0, tab);
    return { ...pane, tabs, activeTabId: tab.id };
  });
  return focusLayoutPane(inserted, paneId);
}

function insertColumn(
  state: LayoutState,
  workspaceId: string,
  index: number,
  column: LayoutColumn,
): LayoutState {
  const inserted = mapWorkspaces(state, (workspace) => {
    if (workspace.id !== workspaceId) return workspace;
    const columns = [...workspace.columns];
    columns.splice(Math.max(0, Math.min(index, columns.length)), 0, column);
    return { ...workspace, columns };
  });
  return focusLayoutPane(normalizeLayout(inserted), column.panes[0]!.id);
}

/**
 * The last column in the run of columns right after `columnIndex` that only
 * hold surfaces of the threads chatting in that column, so a new column lands
 * after a chat's side pane instead of between the two.
 */
function companionRunEnd(workspace: LayoutWorkspace, columnIndex: number): number {
  const column = workspace.columns[columnIndex];
  if (!column) return columnIndex;
  const threads = new Set(
    column.panes.flatMap((pane) =>
      pane.tabs.flatMap((tab) =>
        tab.content.kind === "chat" && tab.content.target.kind === "server"
          ? [scopedThreadKey(tab.content.target.threadRef)]
          : [],
      ),
    ),
  );
  let end = columnIndex;
  for (let index = columnIndex + 1; index < workspace.columns.length; index += 1) {
    const surfacesOnly = workspace.columns[index]!.panes.every((pane) =>
      pane.tabs.every(
        (tab) =>
          tab.content.kind === "surface" && threads.has(scopedThreadKey(tab.content.threadRef)),
      ),
    );
    if (!surfacesOnly) break;
    end = index;
  }
  return end;
}

function splitPaneWithTab(
  state: LayoutState,
  paneId: string,
  side: LayoutDirection,
  tab: LayoutTab,
): LayoutState {
  const found = findPane(state, paneId);
  if (!found) return state;
  if (side === "left" || side === "right") {
    const columnIndex = found.workspace.columns.indexOf(found.column);
    // A chat never lands between another chat and its side pane.
    const insertIndex =
      side === "left"
        ? columnIndex
        : (tab.content.kind !== "surface"
            ? companionRunEnd(found.workspace, columnIndex)
            : columnIndex) + 1;
    // A horizontal split adds a full-width column without resizing its source.
    return insertColumn(state, found.workspace.id, insertIndex, createColumn(createPane(tab)));
  }
  const size = found.pane.size / 2;
  const newPane = createPane(tab, size);
  const split = mapWorkspaces(state, (workspace) =>
    workspace.id !== found.workspace.id
      ? workspace
      : {
          ...workspace,
          columns: workspace.columns.map((column) => {
            if (column.id !== found.column.id) return column;
            const panes = column.panes.flatMap((pane) => {
              if (pane.id !== paneId) return [pane];
              const shrunk = { ...pane, size };
              return side === "up" ? [newPane, shrunk] : [shrunk, newPane];
            });
            return { ...column, panes };
          }),
        },
  );
  return focusLayoutPane(split, newPane.id);
}

/**
 * Open content as a tab, or focus the tab already showing it. With no pane
 * in the focused workspace the tab fills a new full-width column.
 */
export function openLayoutTab(
  state: LayoutState,
  content: LayoutTabContent,
  options: LayoutOpenOptions = {},
): LayoutState {
  const existing = findLayoutTabByContent(state, content);
  if (existing) return focusLayoutTab(state, existing.tab.id);

  const tab = createLayoutTab(content);
  const workspace = selectFocusedWorkspace(state);
  const focusedPane = selectFocusedPane(state);
  const placement = options.placement ?? "active-pane";
  if (!focusedPane) {
    return insertColumn(
      state,
      workspace.id,
      workspace.columns.length,
      createColumn(createPane(tab)),
    );
  }
  if (placement === "split-down") return splitPaneWithTab(state, focusedPane.id, "down", tab);
  if (placement === "new-column") {
    // niri's open-window: a full-width column right after the focused one.
    // The others keep their width; focusing it moves the view there.
    const columnIndex = workspace.columns.findIndex((column) =>
      column.panes.some((pane) => pane.id === focusedPane.id),
    );
    return insertColumn(
      state,
      workspace.id,
      companionRunEnd(workspace, columnIndex) + 1,
      createColumn(createPane(tab)),
    );
  }
  return insertTabIntoPane(state, focusedPane.id, tab, options.position ?? "after-current");
}

/** Swap what a tab shows while keeping its identity, e.g. a draft promoted to a thread. */
export function replaceLayoutTabContent(
  state: LayoutState,
  tabId: string,
  content: LayoutTabContent,
): LayoutState {
  const key = layoutTabContentKey(content);
  const duplicate = findLayoutTab(
    state,
    (tab) => tab.id !== tabId && layoutTabContentKey(tab.content) === key,
  );
  const replaced = mapPanes(state, (pane) => {
    const withoutDuplicate =
      duplicate && pane.id === duplicate.pane.id
        ? { ...pane, tabs: pane.tabs.filter((tab) => tab.id !== duplicate.tab.id) }
        : pane;
    if (!withoutDuplicate.tabs.some((tab) => tab.id === tabId)) return withoutDuplicate;
    return {
      ...withoutDuplicate,
      tabs: withoutDuplicate.tabs.map((tab) =>
        tab.id === tabId &&
        (layoutTabContentKey(tab.content) !== key ||
          (isLayoutPageContent(tab.content) &&
            isLayoutPageContent(content) &&
            tab.content.href !== content.href))
          ? { ...tab, content }
          : tab,
      ),
    };
  });
  return normalizeLayout(replaced);
}

/**
 * Show content the way niri opens a window: focus the tab already showing
 * it, wherever it is, or open it in a new column right after the focused one.
 */
export function showLayoutContent(state: LayoutState, content: LayoutTabContent): LayoutState {
  const existing = findLayoutTabByContent(state, content);
  if (existing) return focusLayoutTab(state, existing.tab.id);
  return openLayoutTab(state, content, { placement: "new-column" });
}

/**
 * Close a tab; its pane activates the neighboring tab, and empty panes
 * collapse. The window's last tab gives way to a launcher in its place, so
 * the window always keeps one pane; that lone launcher does not close.
 */
export function closeLayoutTab(state: LayoutState, tabId: string): LayoutState {
  const location = findLayoutTab(state, (tab) => tab.id === tabId);
  if (!location) return state;
  if (countLayoutTabs(state) === 1) {
    const content = location.tab.content;
    if (content.kind === "launcher") return state;
    const context: ThreadRouteTarget | null =
      content.kind === "chat"
        ? content.target
        : content.kind === "surface"
          ? { kind: "server", threadRef: content.threadRef }
          : null;
    const launcher = createLayoutTab(createLayoutLauncherContent(context));
    return mapPanes(state, (pane) =>
      pane.id === location.pane.id ? { ...pane, tabs: [launcher], activeTabId: launcher.id } : pane,
    );
  }
  const closed = mapPanes(state, (pane) => {
    if (pane.id !== location.pane.id) return pane;
    const tabs = pane.tabs.filter((tab) => tab.id !== tabId);
    const activeTabId =
      pane.activeTabId === tabId
        ? (tabs[Math.min(location.tabIndex, tabs.length - 1)]?.id ?? null)
        : pane.activeTabId;
    return { ...pane, tabs, activeTabId };
  });
  if (location.pane.tabs.length > 1) return normalizeLayout(closed);

  // The pane empties: hand focus to its neighbor in the same column, then the
  // next column over, before normalizing drops it.
  const { workspace, column } = location;
  const paneIndex = column.panes.indexOf(location.pane);
  const columnIndex = workspace.columns.indexOf(column);
  const neighbor =
    column.panes[paneIndex - 1] ??
    column.panes[paneIndex + 1] ??
    workspace.columns[columnIndex - 1]?.panes[0] ??
    workspace.columns[columnIndex + 1]?.panes[0] ??
    null;
  const refocused =
    workspace.focusedPaneId === location.pane.id
      ? mapWorkspaces(closed, (candidate) =>
          candidate.id === workspace.id
            ? { ...candidate, focusedPaneId: neighbor?.id ?? null }
            : candidate,
        )
      : closed;
  return normalizeLayout(refocused);
}

/** Activate the next (1) or previous (-1) tab of the focused pane, wrapping around. */
export function focusAdjacentLayoutTab(state: LayoutState, delta: 1 | -1): LayoutState {
  const pane = selectFocusedPane(state);
  if (!pane || pane.tabs.length < 2) return state;
  const index = pane.tabs.findIndex((tab) => tab.id === pane.activeTabId);
  const next = pane.tabs[(index + delta + pane.tabs.length) % pane.tabs.length]!;
  return focusLayoutTab(state, next.id);
}

/** Close every tab matching the predicate, e.g. tabs of a deleted thread. */
export function closeLayoutTabsWhere(
  state: LayoutState,
  predicate: (tab: LayoutTab) => boolean,
): LayoutState {
  let next = state;
  for (let match = findLayoutTab(next, predicate); match; match = findLayoutTab(next, predicate)) {
    const closed = closeLayoutTab(next, match.tab.id);
    // The window's lone launcher stays.
    if (closed === next) break;
    next = closed;
  }
  return next;
}

/** Move a tab into a pane, beside a pane as a split, or into a new column. */
export function moveLayoutTab(
  state: LayoutState,
  tabId: string,
  destination: LayoutTabDestination,
): LayoutState {
  const location = findLayoutTab(state, (tab) => tab.id === tabId);
  if (!location) return state;
  if (destination.kind === "pane" && destination.paneId === location.pane.id) {
    const index = destination.index ?? location.pane.tabs.length - 1;
    if (index === location.tabIndex) return focusLayoutTab(state, tabId);
    const reordered = mapPanes(state, (pane) => {
      if (pane.id !== location.pane.id) return pane;
      const tabs = pane.tabs.filter((tab) => tab.id !== tabId);
      tabs.splice(Math.max(0, Math.min(index, tabs.length)), 0, location.tab);
      return { ...pane, tabs, activeTabId: tabId };
    });
    return focusLayoutPane(reordered, location.pane.id);
  }
  if (destination.kind === "split" && destination.paneId === location.pane.id) {
    // Splitting a pane with its only tab would leave the original empty.
    if (location.pane.tabs.length === 1) return state;
  }
  if (destination.kind !== "column" && !findPane(state, destination.paneId)) return state;
  if (
    destination.kind === "column" &&
    !state.workspaces.some((workspace) => workspace.id === destination.workspaceId)
  ) {
    return state;
  }

  // Detach without normalizing so the destination pane cannot disappear.
  const detached = mapPanes(state, (pane) => {
    if (pane.id !== location.pane.id) return pane;
    const tabs = pane.tabs.filter((tab) => tab.id !== tabId);
    const activeTabId =
      pane.activeTabId === tabId
        ? (tabs[Math.min(location.tabIndex, tabs.length - 1)]?.id ?? null)
        : pane.activeTabId;
    return { ...pane, tabs, activeTabId };
  });
  const tab = location.tab;
  if (destination.kind === "pane") {
    return normalizeLayout(
      insertTabIntoPane(detached, destination.paneId, tab, destination.index ?? "end"),
    );
  }
  if (destination.kind === "split") {
    return normalizeLayout(splitPaneWithTab(detached, destination.paneId, destination.side, tab));
  }
  // As in niri, a moved window keeps its column's width.
  return insertColumn(
    detached,
    destination.workspaceId,
    destination.index,
    createColumn(createPane(tab), location.column.width),
  );
}

/**
 * Put content at a destination (a thread dropped from the sidebar): move the
 * tab already showing it there, or open a new tab there. Focus follows it.
 */
export function placeLayoutContent(
  state: LayoutState,
  content: LayoutTabContent,
  destination: LayoutTabDestination,
): LayoutState {
  const existing = findLayoutTabByContent(state, content);
  if (existing) {
    const moved = moveLayoutTab(state, existing.tab.id, destination);
    return moved === state ? focusLayoutTab(state, existing.tab.id) : moved;
  }
  const tab = createLayoutTab(content);
  if (destination.kind === "pane") {
    if (!findPane(state, destination.paneId)) return state;
    return normalizeLayout(
      insertTabIntoPane(state, destination.paneId, tab, destination.index ?? "end"),
    );
  }
  if (destination.kind === "split") {
    return normalizeLayout(splitPaneWithTab(state, destination.paneId, destination.side, tab));
  }
  if (!state.workspaces.some((workspace) => workspace.id === destination.workspaceId)) {
    return state;
  }
  return insertColumn(
    state,
    destination.workspaceId,
    destination.index,
    createColumn(createPane(tab)),
  );
}

// Surface tabs

/**
 * Default sizes for a thread's surfaces opened beside or below its chat: the
 * side pane takes 45% of the chat's column, the terminal a third of its pane.
 */
export const DEFAULT_LAYOUT_COMPANION_SIZES: Record<LayoutCompanionKind, number> = {
  panel: 0.45,
  terminal: 1 / 3,
};

export type LayoutTabPlacement = LayoutTabDestination | { kind: "after"; tabId: string };

/** Each workspace's focus as it was in `before`, where its pane still exists. */
function keepLayoutFocus(before: LayoutState, after: LayoutState): LayoutState {
  const restored = mapWorkspaces(after, (workspace) => {
    const previous = before.workspaces.find((candidate) => candidate.id === workspace.id);
    if (!previous || previous.focusedPaneId === workspace.focusedPaneId) return workspace;
    const exists =
      previous.focusedPaneId === null ||
      workspace.columns.some((column) =>
        column.panes.some((pane) => pane.id === previous.focusedPaneId),
      );
    return exists ? { ...workspace, focusedPaneId: previous.focusedPaneId } : workspace;
  });
  const focusedWorkspaceId = restored.workspaces.some(
    (workspace) => workspace.id === before.focusedWorkspaceId,
  )
    ? before.focusedWorkspaceId
    : restored.focusedWorkspaceId;
  return focusedWorkspaceId === restored.focusedWorkspaceId
    ? restored
    : { ...restored, focusedWorkspaceId };
}

/**
 * Put new tabs somewhere as one group: into a pane, after a tab, as a split
 * beside a pane, or as a new column. `activate` is the tab the group shows
 * (null leaves a pane that had a tab showing it); `focus` moves focus there,
 * as a user's open does. An app's open (an agent's diff) leaves focus alone.
 */
export function placeLayoutTabs(
  state: LayoutState,
  tabs: readonly LayoutTab[],
  placement: LayoutTabPlacement,
  options: { activate: string | null; focus: boolean },
): LayoutState {
  const [first, ...rest] = tabs;
  if (!first) return state;
  let destination: LayoutTabDestination;
  if (placement.kind === "after") {
    const anchor = findLayoutTab(state, (tab) => tab.id === placement.tabId);
    if (!anchor) return state;
    destination = { kind: "pane", paneId: anchor.pane.id, index: anchor.tabIndex + 1 };
  } else {
    destination = placement;
  }
  let next: LayoutState;
  if (destination.kind === "pane") {
    if (!findPane(state, destination.paneId)) return state;
    next = insertTabIntoPane(state, destination.paneId, first, destination.index ?? "end");
  } else if (destination.kind === "split") {
    if (!findPane(state, destination.paneId)) return state;
    next = splitPaneWithTab(state, destination.paneId, destination.side, first);
  } else {
    if (!state.workspaces.some((workspace) => workspace.id === destination.workspaceId)) {
      return state;
    }
    next = insertColumn(
      state,
      destination.workspaceId,
      destination.index,
      createColumn(createPane(first)),
    );
  }
  const pane = findLayoutTab(next, (tab) => tab.id === first.id)?.pane;
  if (!pane) return state;
  const paneHadTab = destination.kind === "pane" && pane.tabs.length > 1;
  next = mapPanes(next, (candidate) => {
    if (candidate.id !== pane.id) return candidate;
    const tabs = [...candidate.tabs];
    tabs.splice(tabs.findIndex((tab) => tab.id === first.id) + 1, 0, ...rest);
    // A pane that showed a tab keeps showing it unless told otherwise.
    const before = paneHadTab
      ? (state.workspaces
          .flatMap((workspace) => workspace.columns)
          .flatMap((column) => column.panes)
          .find((entry) => entry.id === pane.id)?.activeTabId ?? null)
      : null;
    const activeTabId =
      options.activate !== null && tabs.some((tab) => tab.id === options.activate)
        ? options.activate
        : (before ?? first.id);
    return { ...candidate, tabs, activeTabId };
  });
  next = normalizeLayout(next);
  if (options.focus) {
    const shown = options.activate ?? first.id;
    return focusLayoutTab(next, findLayoutTab(next, (tab) => tab.id === shown) ? shown : first.id);
  }
  return keepLayoutFocus(state, next);
}

/**
 * What a surface pane opened beside (`panel`) or below (`terminal`) a chat
 * takes of it: its share of the chat's column pair, or of the stacked panes.
 * Null when it sits anywhere else. The next open there reuses it.
 */
export function measureLayoutBeside(
  state: LayoutState,
  surfaceTabId: string,
  chatTabId: string,
  kind: LayoutCompanionKind,
  mode: LayoutWhenNoRoom,
): number | null {
  const surface = findLayoutTab(state, (tab) => tab.id === surfaceTabId);
  const chat = findLayoutTab(state, (tab) => tab.id === chatTabId);
  if (!surface || !chat || surface.workspace.id !== chat.workspace.id) return null;
  if (surface.pane.id === chat.pane.id) return null;
  if (kind === "terminal") {
    if (surface.column.id !== chat.column.id) return null;
    return surface.pane.size / (surface.pane.size + chat.pane.size);
  }
  const columns = chat.workspace.columns;
  if (columns.indexOf(surface.column) !== columns.indexOf(chat.column) + 1) return null;
  return mode === "always-scroll"
    ? surface.column.width
    : surface.column.width / (surface.column.width + chat.column.width);
}

/**
 * Size a pane just opened beside or below a chat to `share` of what the two
 * hold together; `floor` is the narrowest a column may get.
 */
export function shareLayoutBeside(
  state: LayoutState,
  surfaceTabId: string,
  chatTabId: string,
  kind: LayoutCompanionKind,
  share: number,
  mode: LayoutWhenNoRoom,
  floor: number,
): LayoutState {
  const surface = findLayoutTab(state, (tab) => tab.id === surfaceTabId);
  const chat = findLayoutTab(state, (tab) => tab.id === chatTabId);
  if (!surface || !chat || surface.pane.id === chat.pane.id) return state;
  const fraction = Math.max(0.15, Math.min(0.85, share));
  if (kind === "terminal") {
    if (surface.column.id !== chat.column.id) return state;
    const pair = surface.pane.size + chat.pane.size;
    return resizeLayoutPane(state, chat.pane.id, pair * (1 - fraction));
  }
  if (mode === "always-scroll") return resizeLayoutColumn(state, surface.column.id, share);
  const pair = surface.column.width + chat.column.width;
  return resizeLayoutColumn(
    resizeLayoutColumn(state, chat.column.id, Math.max(floor, pair * (1 - fraction))),
    surface.column.id,
    Math.max(floor, pair * fraction),
  );
}

// Size updates.

export function resizeLayoutColumn(
  state: LayoutState,
  columnId: string,
  width: number,
): LayoutState {
  if (!Number.isFinite(width)) return state;
  const clamped = Math.max(LAYOUT_MIN_COLUMN_WIDTH, width);
  return mapWorkspaces(state, (workspace) => {
    if (!workspace.columns.some((column) => column.id === columnId && column.width !== clamped)) {
      return workspace;
    }
    return {
      ...workspace,
      columns: workspace.columns.map((column) =>
        column.id === columnId ? { ...column, width: clamped } : column,
      ),
    };
  });
}

/** Step to the next width preset, wrapping from 2/3 back to 1/3. A lone column keeps filling the window. */
export function cycleLayoutColumnWidth(state: LayoutState, columnId: string): LayoutState {
  const workspace = state.workspaces.find((candidate) =>
    candidate.columns.some((column) => column.id === columnId),
  );
  const column = workspace?.columns.find((candidate) => candidate.id === columnId);
  if (!workspace || !column || workspace.columns.length === 1) return state;
  const next =
    LAYOUT_COLUMN_WIDTH_PRESETS.find((preset) => preset > column.width + 1e-3) ??
    LAYOUT_COLUMN_WIDTH_PRESETS[0];
  return resizeLayoutColumn(state, columnId, next);
}

/**
 * Resize a pane within its column. The pane below (or above, for the last
 * pane) absorbs the difference so the column still sums to 1.
 */
export function resizeLayoutPane(state: LayoutState, paneId: string, size: number): LayoutState {
  if (!Number.isFinite(size)) return state;
  const found = findPane(state, paneId);
  if (!found || found.column.panes.length < 2) return state;
  const panes = found.column.panes;
  const index = panes.indexOf(found.pane);
  const neighborIndex = index + 1 < panes.length ? index + 1 : index - 1;
  const neighbor = panes[neighborIndex]!;
  const pairTotal = found.pane.size + neighbor.size;
  const minimum = Math.min(LAYOUT_MIN_PANE_SIZE, pairTotal / 2);
  const clamped = Math.max(minimum, Math.min(pairTotal - minimum, size));
  if (Math.abs(clamped - found.pane.size) < 1e-6) return state;
  return mapPanes(state, (pane) =>
    pane.id === paneId
      ? { ...pane, size: clamped }
      : pane.id === neighbor.id
        ? { ...pane, size: pairTotal - clamped }
        : pane,
  );
}

// Persistence format.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRouteTarget(target: unknown): target is ThreadRouteTarget {
  if (!isRecord(target)) return false;
  if (target.kind === "draft") return typeof target.draftId === "string";
  return (
    target.kind === "server" &&
    isRecord(target.threadRef) &&
    typeof target.threadRef.environmentId === "string" &&
    typeof target.threadRef.threadId === "string"
  );
}

function isTabContent(value: unknown): value is LayoutTabContent {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "settings" || value.kind === "usage" || value.kind === "pull-requests") {
    if (value.href === undefined) return true;
    if (typeof value.href !== "string") return false;
    const pathname = value.href.split(/[?#]/, 1)[0];
    return value.kind === "settings"
      ? pathname?.startsWith("/settings/") === true
      : pathname === `/${value.kind}`;
  }
  if (value.kind === "chat") return isRouteTarget(value.target);
  if (value.kind === "launcher") {
    return typeof value.id === "string" && (value.context === null || isRouteTarget(value.context));
  }
  if (value.kind === "surface") {
    return typeof value.surfaceId === "string" && isThreadRef(value.threadRef);
  }
  // A side pane or terminal saved before surfaces were tabs of their own.
  return (
    (value.kind === "panel" || value.kind === "terminal") &&
    typeof value.ownerTabId === "string" &&
    isThreadRef(value.threadRef)
  );
}

function isThreadRef(value: unknown): value is ScopedThreadRef {
  return (
    isRecord(value) && typeof value.environmentId === "string" && typeof value.threadId === "string"
  );
}

/**
 * A side pane saved before surfaces were tabs becomes a placeholder its
 * thread's surfaces replace on load; a terminal becomes the thread's terminal
 * tab. Both keep the tab's id and place.
 */
function migrateLegacyTabContent(content: unknown): LayoutTabContent {
  const legacy = content as { kind: string; threadRef: ScopedThreadRef };
  if (legacy.kind === "settings" || legacy.kind === "usage") {
    return createLayoutLauncherContent(null);
  }
  if (legacy.kind === "panel") {
    return { kind: "surface", threadRef: legacy.threadRef, surfaceId: LEGACY_PANEL_SURFACE_ID };
  }
  if (legacy.kind === "terminal") {
    return {
      kind: "surface",
      threadRef: legacy.threadRef,
      surfaceId: THREAD_TERMINAL_SURFACE_ID,
    };
  }
  return content as LayoutTabContent;
}

function isFraction(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1;
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Decode a persisted layout, falling back to the default when any part is malformed. */
export function decodePersistedLayoutState(value: unknown): LayoutState {
  if (!isRecord(value) || !Array.isArray(value.workspaces)) return createLayoutState();
  const valid =
    typeof value.focusedWorkspaceId === "string" &&
    value.workspaces.every(
      (workspace) =>
        isRecord(workspace) &&
        typeof workspace.id === "string" &&
        (workspace.name === null || typeof workspace.name === "string") &&
        (workspace.focusedPaneId === null || typeof workspace.focusedPaneId === "string") &&
        Array.isArray(workspace.columns) &&
        workspace.columns.every(
          (column) =>
            isRecord(column) &&
            typeof column.id === "string" &&
            isPositive(column.width) &&
            Array.isArray(column.panes) &&
            column.panes.every(
              (pane) =>
                isRecord(pane) &&
                typeof pane.id === "string" &&
                isFraction(pane.size) &&
                (pane.activeTabId === null || typeof pane.activeTabId === "string") &&
                Array.isArray(pane.tabs) &&
                pane.tabs.every(
                  (tab) => isRecord(tab) && typeof tab.id === "string" && isTabContent(tab.content),
                ),
            ),
        ),
    );
  if (!valid) return createLayoutState();
  return normalizeLayout({
    // Layouts saved before workspaces kept their width pin when first drawn.
    workspaces: (value.workspaces as LayoutWorkspace[]).map((workspace) => ({
      ...workspace,
      cameraWidth: isPositive(workspace.cameraWidth) ? workspace.cameraWidth : null,
      columns: workspace.columns.map((column) => ({
        ...column,
        panes: column.panes.map((pane) => ({
          ...pane,
          tabs: pane.tabs.map((tab) => ({ ...tab, content: migrateLegacyTabContent(tab.content) })),
        })),
      })),
    })),
    focusedWorkspaceId: value.focusedWorkspaceId as string,
  });
}
