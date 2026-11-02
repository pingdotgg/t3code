import type { PointerEvent as ReactPointerEvent } from "react";

import {
  resolveDockDrop,
  type DockDropResolution,
  type DockDropTarget,
  type DockGroupGeometry,
  type DockRect,
  type DockStackGeometry,
} from "./dockDrop";
import { CHAT_GROUP_ID } from "./dockLayout";

const DRAG_THRESHOLD_PX = 6;

const toRect = ({ left, top, width, height }: DOMRect): DockRect => ({ left, top, width, height });

function readDockGeometry(root: Element): readonly DockGroupGeometry[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-dock-group]")).map((group) => {
    const tabbar = group.querySelector("[data-dock-tabbar]");
    return {
      id: group.dataset.dockGroup!,
      sealed: group.dataset.dockGroup === CHAT_GROUP_ID,
      rect: toRect(group.getBoundingClientRect()),
      tabbar: tabbar ? toRect(tabbar.getBoundingClientRect()) : null,
      tabs: Array.from(group.querySelectorAll<HTMLElement>("[data-dock-tab]")).map((tab) => ({
        id: tab.dataset.dockTab!,
        rect: toRect(tab.getBoundingClientRect()),
      })),
    };
  });
}

function readDockStacks(root: Element): readonly DockStackGeometry[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-dock-stack]")).map((stack) => ({
    id: stack.dataset.dockStack!,
    direction: stack.dataset.dockDirection === "row" ? "row" : "column",
    rect: toRect(stack.getBoundingClientRect()),
  }));
}

function createOverlay(className: string): HTMLDivElement {
  const element = document.createElement("div");
  element.className = className;
  element.hidden = true;
  element.setAttribute("aria-hidden", "true");
  document.body.append(element);
  return element;
}

function placeOverlay(element: HTMLElement, rect: DockRect) {
  element.hidden = false;
  element.style.left = `${rect.left}px`;
  element.style.top = `${rect.top}px`;
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
}

/**
 * Watches a tab press and turns it into a drag once it moves, leaving plain clicks alone. Updates
 * two overlay elements directly, so a drag never re-renders the workspace.
 */
export function beginDockDrag(input: {
  readonly event: ReactPointerEvent;
  readonly label: string;
  readonly sourceGroupId: string;
  readonly sourceTabCount: number;
  readonly onDrop: (target: DockDropTarget) => void;
}) {
  const { event, label, onDrop, sourceGroupId, sourceTabCount } = input;
  if (event.button !== 0 || event.pointerType === "touch") return;
  const root = document.querySelector("[data-dock-root]");
  if (!root) return;
  const { pointerId, clientX: startX, clientY: startY } = event;
  let geometry: readonly DockGroupGeometry[] | null = null;
  let stacks: readonly DockStackGeometry[] = [];
  let resolution: DockDropResolution | null = null;
  let preview: HTMLDivElement | null = null;
  let ghost: HTMLDivElement | null = null;

  const start = () => {
    geometry = readDockGeometry(root);
    stacks = readDockStacks(root);
    preview = createOverlay(
      "pointer-events-none fixed z-[1000] rounded-md border-2 border-primary/60 bg-primary/10",
    );
    ghost = createOverlay(
      "pointer-events-none fixed z-[1001] max-w-48 truncate rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md",
    );
    ghost.textContent = label;
    ghost.hidden = false;
    document.documentElement.dataset.dockDragging = "true";
  };

  const finish = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("blur", cancel);
    preview?.remove();
    ghost?.remove();
    delete document.documentElement.dataset.dockDragging;
  };

  const cancel = () => finish();

  const onMove = (move: PointerEvent) => {
    if (move.pointerId !== pointerId) return;
    if (!geometry) {
      if (Math.hypot(move.clientX - startX, move.clientY - startY) < DRAG_THRESHOLD_PX) return;
      start();
    }
    move.preventDefault();
    if (ghost) {
      ghost.style.left = `${move.clientX + 12}px`;
      ghost.style.top = `${move.clientY + 12}px`;
    }
    resolution = resolveDockDrop({
      x: move.clientX,
      y: move.clientY,
      root: toRect(root.getBoundingClientRect()),
      groups: geometry ?? [],
      stacks,
      sourceGroupId,
      sourceTabCount,
    });
    if (preview) {
      if (resolution) placeOverlay(preview, resolution.preview);
      else preview.hidden = true;
    }
  };

  const onUp = (up: PointerEvent) => {
    if (up.pointerId !== pointerId) return;
    const dragged = geometry !== null;
    const dropped = resolution;
    finish();
    if (!dragged) return;
    // The click ending this press is not that tab's click. A drop can move the tab so no click
    // follows, and a listener left armed would eat the user's next one, so it expires.
    const swallowClick = (click: MouseEvent) => click.stopPropagation();
    window.addEventListener("click", swallowClick, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", swallowClick, true));
    if (dropped) onDrop(dropped.target);
  };

  const onKeyDown = (key: KeyboardEvent) => {
    if (key.key !== "Escape" || !geometry) return;
    key.preventDefault();
    key.stopPropagation();
    finish();
  };

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("blur", cancel);
}
