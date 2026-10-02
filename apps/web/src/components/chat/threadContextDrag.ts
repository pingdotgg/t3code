import type { ScopedThreadRef } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

/**
 * Sidebar-to-composer thread-context drag bridge.
 *
 * Dragging a sidebar thread past the list edge turns the gesture into a
 * context drop. The composer form marks itself as the target (see
 * `threadContextDropTargetProps`); the sidebar hit-tests the pointer against
 * it and hands over the dragged thread refs through a DOM event, so neither
 * side imports the other. Ghost position lives here rather than in Sidebar
 * state so pointer moves only re-render the ghost.
 *
 * Receiver contract (composer side, not owned by this module):
 * - Listen for `THREAD_CONTEXT_DROP_EVENT` on the composer `<form>`.
 * - The event is `CustomEvent<ReadonlyArray<ScopedThreadRef>>` and is
 *   cancelable. Call `event.preventDefault()` only when the drop is actually
 *   accepted (after the receiver's own self-thread, cross-environment, busy,
 *   and disabled checks).
 * - `dropThreadContext` returns `true` only when the receiver accepted.
 *   Finding a target alone is NOT success: an undispatched or unaccepted
 *   drop reports `false` so the sidebar never claims an attachment it did
 *   not make.
 */

export const THREAD_CONTEXT_DROP_EVENT = "t3-thread-context-drop";
const DROP_TARGET_ATTRIBUTE = "data-thread-context-drop";
const DROP_DISABLED_ATTRIBUTE = "data-thread-context-drop-disabled";
const DROP_OVER_ATTRIBUTE = "data-thread-context-over";

export interface ThreadContextDragPoint {
  readonly x: number;
  readonly y: number;
}

export interface ThreadContextDragLabel {
  readonly title: string;
  readonly count: number;
}

export interface ThreadContextDragGhost extends ThreadContextDragPoint, ThreadContextDragLabel {}

/**
 * Capability gate for a future composer integration. The sidebar passes
 * `enabled: false` while a drop cannot be accepted (composer busy or
 * disabled) without this module learning any composer state; the target can
 * also mark itself with `data-thread-context-drop-disabled`. Absent (or
 * `enabled: true`) means no sidebar-side objection — the receiver still has
 * the final say via `preventDefault`.
 */
export interface ThreadContextDropOptions {
  readonly enabled?: boolean;
}

let ghost: ThreadContextDragGhost | null = null;
const listeners = new Set<() => void>();

function setGhost(next: ThreadContextDragGhost | null) {
  if (ghost === next) return;
  ghost = next;
  for (const listener of listeners) listener();
}

function subscribeThreadContextDragGhost(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useThreadContextDragGhost(): ThreadContextDragGhost | null {
  return useSyncExternalStore(
    subscribeThreadContextDragGhost,
    () => ghost,
    () => null,
  );
}

let overTarget: {
  removeAttribute: (name: string) => void;
  setAttribute: (name: string, value: string) => void;
  hasAttribute?: (name: string) => boolean;
} | null = null;

function findDropTarget(point: ThreadContextDragPoint): HTMLElement | null {
  if (typeof document === "undefined" || typeof document.elementFromPoint !== "function") {
    return null;
  }
  return (
    document
      .elementFromPoint(point.x, point.y)
      ?.closest<HTMLElement>(`[${DROP_TARGET_ATTRIBUTE}]`) ?? null
  );
}

function isDropDisabled(target: HTMLElement): boolean {
  return target.hasAttribute(DROP_DISABLED_ATTRIBUTE);
}

/** Tracks the ghost and the highlighted drop target while the pointer is outside the list. */
export function moveThreadContextDrag(
  point: ThreadContextDragPoint,
  label: ThreadContextDragLabel,
): void {
  const target = findDropTarget(point);
  if (target !== overTarget) {
    overTarget?.removeAttribute(DROP_OVER_ATTRIBUTE);
    if (target && !isDropDisabled(target)) {
      target.setAttribute(DROP_OVER_ATTRIBUTE, "true");
    }
    overTarget = target;
  }
  setGhost({ x: point.x, y: point.y, ...label });
}

export function endThreadContextDrag(): void {
  overTarget?.removeAttribute(DROP_OVER_ATTRIBUTE);
  overTarget = null;
  setGhost(null);
}

/**
 * True only when a composer accepted the drop (cancelled the event). False
 * covers every other outcome: no target under the pointer, an empty ref
 * list, a sidebar-side capability gate, a self-disabled target, and a target
 * that received the event but rejected it.
 */
export function dropThreadContext(
  point: ThreadContextDragPoint,
  threads: ReadonlyArray<ScopedThreadRef>,
  options?: ThreadContextDropOptions,
): boolean {
  if (options?.enabled === false || threads.length === 0) return false;
  const target = findDropTarget(point);
  if (!target || isDropDisabled(target)) return false;
  const event = new CustomEvent<ReadonlyArray<ScopedThreadRef>>(THREAD_CONTEXT_DROP_EVENT, {
    detail: Object.freeze([...threads]),
    cancelable: true,
    bubbles: true,
  });
  target.dispatchEvent(event);
  // Acceptance is the receiver cancelling the cancelable event. A target
  // that merely exists — or receives but rejects the drop — leaves this
  // false, so the sidebar never claims an attachment it did not make.
  return event.defaultPrevented;
}

export function threadContextDropTargetProps() {
  return { [DROP_TARGET_ATTRIBUTE]: "true" } as const;
}
