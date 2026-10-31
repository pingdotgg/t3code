/**
 * Keep pointer state outside React so movement re-renders only the drop zones.
 * Measure targets from current DOM geometry on each move.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ContextMenuItem, ScopedThreadRef } from "@t3tools/contracts";
import { useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";

import {
  countLayoutTabs,
  findLayoutPane,
  findLayoutTab,
  selectFocusedChatTab,
  selectFocusedWorkspace,
  type LayoutDirection,
  type LayoutState,
  type LayoutTabDestination,
} from "./layoutModel";
import { saveLayoutNow, useLayoutStore } from "./layoutStore";

export type LayoutDragSource =
  | { kind: "tab"; tabId: string }
  | { kind: "thread"; threadRef: ScopedThreadRef };

export type LayoutDropTarget =
  | { kind: "side"; paneId: string; side: LayoutDirection }
  | { kind: "into"; paneId: string; index?: number }
  | { kind: "extend"; edge: "left" | "right" | "bottom" };

export interface LayoutDragRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface LayoutDragPane {
  paneId: string;
  rect: LayoutDragRect;
  tabs?: readonly { id: string; rect: LayoutDragRect }[];
  /** A side panel or terminal pane: splits beside it, but no tabs into it. */
  companion: boolean;
}

export interface LayoutDragState {
  source: LayoutDragSource;
  point: { x: number; y: number };
  panes: readonly LayoutDragPane[];
  strip: LayoutDragRect;
  target: LayoutDropTarget | null;
}

/** The chrome row at the top of a pane: dropping there adds a tab (pen: zones start 48px down). */
export const LAYOUT_DROP_CHROME_HEIGHT = 48;
/** How close to the strip's left, right or bottom edge extends the layout (pen ZyA9S, Yyoy8, JYBD5). */
const EXTEND_BAND = 10;
/** Past the strip, toward the sidebar gutter, the edge still counts. */
const EXTEND_OUTSIDE = 16;
/** Pointer travel before a press on a tab becomes a drag, so clicks keep working. */
const DRAG_THRESHOLD = 6;

let dragState: LayoutDragState | null = null;
const listeners = new Set<() => void>();

function setDragState(next: LayoutDragState | null) {
  if (dragState === next) return;
  dragState = next;
  for (const listener of listeners) listener();
}

export function useLayoutDragState(): LayoutDragState | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => dragState,
    () => null,
  );
}

export function isLayoutDragActive(): boolean {
  return dragState !== null;
}

function toRect(rect: DOMRect): LayoutDragRect {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function measure(): { panes: LayoutDragPane[]; strip: LayoutDragRect } | null {
  const strip = document.querySelector<HTMLElement>("[data-layout-strip]");
  if (!strip) return null;
  const panes = [...document.querySelectorAll<HTMLElement>("[data-layout-pane-id]")].flatMap(
    (element) => {
      const paneId = element.dataset.layoutPaneId;
      const rect = element.getBoundingClientRect();
      if (!paneId || rect.width === 0 || rect.height === 0) return [];
      const tabs = [...element.querySelectorAll<HTMLElement>("[data-layout-pane-tab]")].map(
        (tab) => ({ id: tab.dataset.layoutPaneTab!, rect: toRect(tab.getBoundingClientRect()) }),
      );
      return [
        { paneId, rect: toRect(rect), tabs, companion: element.dataset.layoutCompanion != null },
      ];
    },
  );
  return { panes, strip: toRect(strip.getBoundingClientRect()) };
}

function contains(rect: LayoutDragRect, point: { x: number; y: number }): boolean {
  return (
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
  );
}

/**
 * The pane side or strip edge under the pointer. Also drives the Settings >
 * Layout editor's mini canvas, which passes its own rects and no chrome row.
 */
export function resolveLayoutDropTarget(
  point: { x: number; y: number },
  panes: readonly LayoutDragPane[],
  strip: LayoutDragRect,
  chromeHeight = LAYOUT_DROP_CHROME_HEIGHT,
): LayoutDropTarget | null {
  const withinY = point.y >= strip.top && point.y <= strip.bottom + EXTEND_OUTSIDE;
  const withinX = point.x >= strip.left - EXTEND_OUTSIDE && point.x <= strip.right + EXTEND_OUTSIDE;
  if (withinY && point.x >= strip.left - EXTEND_OUTSIDE && point.x < strip.left + EXTEND_BAND) {
    return { kind: "extend", edge: "left" };
  }
  if (withinY && point.x <= strip.right + EXTEND_OUTSIDE && point.x > strip.right - EXTEND_BAND) {
    return { kind: "extend", edge: "right" };
  }
  if (withinX && point.y <= strip.bottom + EXTEND_OUTSIDE && point.y > strip.bottom - EXTEND_BAND) {
    return { kind: "extend", edge: "bottom" };
  }
  const pane = panes.find((candidate) => contains(candidate.rect, point));
  if (!pane) return null;
  const bodyTop = pane.rect.top + chromeHeight;
  if (point.y < bodyTop) {
    return pane.companion ? null : { kind: "into", paneId: pane.paneId };
  }
  // The nearest side of the pane body, measured in fractions so wide and
  // tall panes split both ways.
  const width = Math.max(1, pane.rect.right - pane.rect.left);
  const height = Math.max(1, pane.rect.bottom - bodyTop);
  const dx = (point.x - pane.rect.left) / width;
  const dy = (point.y - bodyTop) / height;
  const distances: Array<[LayoutDirection, number]> = [
    ["left", dx],
    ["right", 1 - dx],
    ["up", dy],
    ["down", 1 - dy],
  ];
  const side = distances.reduce((best, entry) => (entry[1] < best[1] ? entry : best))[0];
  return { kind: "side", paneId: pane.paneId, side };
}

/** Where a drop target puts the tab, in model terms. */
function layoutDropDestination(
  layout: LayoutState,
  target: LayoutDropTarget,
): LayoutTabDestination | null {
  if (target.kind === "side") return { kind: "split", paneId: target.paneId, side: target.side };
  if (target.kind === "into")
    return {
      kind: "pane",
      paneId: target.paneId,
      ...(target.index === undefined ? {} : { index: target.index }),
    };
  const workspace = selectFocusedWorkspace(layout);
  if (target.edge === "left") return { kind: "column", workspaceId: workspace.id, index: 0 };
  if (target.edge === "right") {
    return { kind: "column", workspaceId: workspace.id, index: workspace.columns.length };
  }
  // The bottom edge starts a workspace below: the empty one that always
  // waits at the bottom.
  const trailing = layout.workspaces.at(-1);
  if (!trailing || trailing.id === workspace.id) return null;
  return { kind: "column", workspaceId: trailing.id, index: 0 };
}

/**
 * Drops that would leave the layout as it is: a tab dropped on its own pane
 * when it is that pane's only tab, into the pane it already sits in, or out
 * to an edge when it is already alone there.
 */
function isLayoutDropUseful(
  layout: LayoutState,
  source: LayoutDragSource,
  target: LayoutDropTarget,
): boolean {
  if (layoutDropDestination(layout, target) === null) return false;
  if (source.kind === "thread") return true;
  const location = findLayoutTab(layout, (tab) => tab.id === source.tabId);
  if (!location) return false;
  const alone = location.pane.tabs.length === 1;
  if (target.kind === "into") {
    return (
      target.paneId !== location.pane.id ||
      (target.index !== undefined && target.index !== location.tabIndex)
    );
  }
  if (target.kind === "side") return !(alone && target.paneId === location.pane.id);
  const workspace = selectFocusedWorkspace(layout);
  const paneCount = workspace.columns.reduce((sum, column) => sum + column.panes.length, 0);
  if (target.edge === "bottom") {
    const tabCount = workspace.columns.reduce(
      (sum, column) => sum + column.panes.reduce((inner, pane) => inner + pane.tabs.length, 0),
      0,
    );
    return tabCount > 1;
  }
  if (!alone || paneCount > 1) {
    const columns = workspace.columns;
    const edgeColumn = target.edge === "left" ? columns[0] : columns.at(-1);
    // Already the lone pane of the edge column.
    return !(
      alone &&
      edgeColumn?.panes.length === 1 &&
      edgeColumn.panes[0]!.id === location.pane.id
    );
  }
  return false;
}

/** The label on the pill under the pointer (pen MI18S "Side by side", nYpzc "Below"). */
export function layoutDropLabel(target: LayoutDropTarget): string {
  if (target.kind === "into") return "Add as tab";
  if (target.kind === "extend") {
    return target.edge === "bottom" ? "New workspace" : "New column";
  }
  switch (target.side) {
    case "left":
    case "right":
      return "Side by side";
    case "up":
      return "Above";
    case "down":
      return "Below";
  }
}

/**
 * Follow the pointer. `allowTarget: false` keeps the zones visible but
 * targets nothing, e.g. while a sidebar thread hovers a composer, which
 * takes it as context instead.
 */
export function moveLayoutDrag(
  source: LayoutDragSource,
  point: { x: number; y: number },
  options: { allowTarget?: boolean } = {},
): void {
  const measured = measure();
  if (!measured) {
    setDragState(null);
    return;
  }
  const layout = useLayoutStore.getState().layout;
  let raw =
    options.allowTarget === false
      ? null
      : resolveLayoutDropTarget(point, measured.panes, measured.strip);
  if (raw?.kind === "into") {
    const paneId = raw.paneId;
    const tabs = measured.panes
      .find((pane) => pane.paneId === paneId)
      ?.tabs?.filter((tab) => source.kind !== "tab" || tab.id !== source.tabId);
    if (tabs) {
      const before = tabs.findIndex((tab) => point.x < (tab.rect.left + tab.rect.right) / 2);
      raw = { ...raw, index: before === -1 ? tabs.length : before };
    }
  }
  const target =
    raw && isLayoutDropUseful(layout, source, raw) && isKnownPane(layout, raw) ? raw : null;
  const previous = dragState;
  if (
    previous &&
    sameSource(previous.source, source) &&
    previous.point.x === point.x &&
    previous.point.y === point.y &&
    sameTarget(previous.target, target)
  ) {
    return;
  }
  setDragState({ source, point, panes: measured.panes, strip: measured.strip, target });
}

function sameSource(a: LayoutDragSource, b: LayoutDragSource): boolean {
  if (a.kind === "tab" || b.kind === "tab") {
    return a.kind === "tab" && b.kind === "tab" && a.tabId === b.tabId;
  }
  return scopedThreadKey(a.threadRef) === scopedThreadKey(b.threadRef);
}

function isKnownPane(layout: LayoutState, target: LayoutDropTarget): boolean {
  return target.kind === "extend" || findLayoutPane(layout, target.paneId) !== null;
}

function sameTarget(a: LayoutDropTarget | null, b: LayoutDropTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "extend" && b.kind === "extend") return a.edge === b.edge;
  if (a.kind === "into" && b.kind === "into") return a.paneId === b.paneId && a.index === b.index;
  return a.kind === "side" && b.kind === "side" && a.paneId === b.paneId && a.side === b.side;
}

/** Commit the current target, if any. Returns true when the layout took the drop. */
export function dropLayoutDrag(): boolean {
  const current = dragState;
  setDragState(null);
  if (!current?.target) return false;
  return commitLayoutDrop(current.source, current.target);
}

export function cancelLayoutDrag(): void {
  setDragState(null);
}

/** Apply a drop: move the tab, or place the dragged thread's chat. */
function commitLayoutDrop(source: LayoutDragSource, target: LayoutDropTarget): boolean {
  const store = useLayoutStore.getState();
  const destination = layoutDropDestination(store.layout, target);
  if (!destination || !isLayoutDropUseful(store.layout, source, target)) return false;
  if (source.kind === "tab") {
    store.moveTab(source.tabId, destination);
  } else {
    store.placeContent(
      { kind: "chat", target: { kind: "server", threadRef: source.threadRef } },
      destination,
    );
  }
  saveLayoutNow();
  return true;
}

export const OPEN_THREAD_TO_THE_SIDE_MENU_ID = "open-to-the-side" as const;

/** The pane a thread opened "to the side" splits: the chat behind the focused pane. */
function sideAnchorPaneId(layout: LayoutState, threadRef: ScopedThreadRef): string | null {
  const focused = selectFocusedChatTab(layout);
  if (!focused) return null;
  const content = focused.tab.content;
  // The thread is the one being looked at: there is no side to open it to.
  if (
    content.kind === "chat" &&
    content.target.kind === "server" &&
    scopedThreadKey(content.target.threadRef) === scopedThreadKey(threadRef)
  ) {
    return null;
  }
  return focused.pane.id;
}

/** Whether "Open to the side" (the sidebar row menu) has somewhere to go. */
function canOpenThreadToTheSide(threadRef: ScopedThreadRef): boolean {
  return sideAnchorPaneId(useLayoutStore.getState().layout, threadRef) !== null;
}

/**
 * A thread row's menu with "Open to the side" on top when there is a side to
 * open to: the menu way to what dragging the row into the layout does.
 */
export function withOpenThreadToTheSideItem<T extends string>(
  threadRef: ScopedThreadRef,
  items: readonly ContextMenuItem<T>[],
): ContextMenuItem<T | typeof OPEN_THREAD_TO_THE_SIDE_MENU_ID>[] {
  if (!canOpenThreadToTheSide(threadRef)) return [...items];
  return [
    { id: OPEN_THREAD_TO_THE_SIDE_MENU_ID, label: "Open to the side", icon: "panel-right" },
    ...items.map((item, index) => (index === 0 ? { ...item, separatorBefore: true } : item)),
  ];
}

/**
 * The menu alternative to dragging a sidebar thread onto the right side of
 * the focused pane: its chat opens (or moves) beside it, side by side.
 */
export function openThreadToTheSide(threadRef: ScopedThreadRef): void {
  const paneId = sideAnchorPaneId(useLayoutStore.getState().layout, threadRef);
  if (paneId === null) return;
  commitLayoutDrop({ kind: "thread", threadRef }, { kind: "side", paneId, side: "right" });
}

/**
 * Start dragging a notch tab on a press that travels past the threshold.
 * Below it the press stays a click (menus, rename, focus). Once dragging, the
 * click that ends the gesture is swallowed and Escape cancels.
 */
export function beginLayoutTabDrag(event: ReactPointerEvent, tabId: string): void {
  if (event.button !== 0 || event.pointerType === "touch") return;
  // A lone tab has nowhere to go.
  if (countLayoutTabs(useLayoutStore.getState().layout) < 2) return;
  const start = { x: event.clientX, y: event.clientY };
  const pointerId = event.pointerId;
  const source = { kind: "tab", tabId } as const;
  let started = false;

  const move = (moveEvent: PointerEvent) => {
    if (moveEvent.pointerId !== pointerId) return;
    if (!started) {
      if (Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y) < DRAG_THRESHOLD) {
        return;
      }
      started = true;
    }
    moveEvent.preventDefault();
    moveLayoutDrag(source, { x: moveEvent.clientX, y: moveEvent.clientY });
  };
  const finish = (commit: boolean) => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    window.removeEventListener("blur", cancel);
    if (!started) return;
    if (commit) dropLayoutDrag();
    else cancelLayoutDrag();
    // The release that ends a drag must not also open the tab's menu.
    const swallow = (clickEvent: MouseEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallow, true), 0);
  };
  const up = (upEvent: PointerEvent) => {
    if (upEvent.pointerId === pointerId) finish(true);
  };
  const cancel = () => finish(false);
  const key = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key !== "Escape" || !started) return;
    keyEvent.preventDefault();
    keyEvent.stopPropagation();
    finish(false);
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", key, true);
  window.addEventListener("blur", cancel);
}
