import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { type RefObject, useEffect, useEffectEvent, useSyncExternalStore } from "react";

export const THREAD_CONTEXT_DROP_EVENT = "t3-thread-context-drop";

export function useThreadContextDrop(
  targetRef: RefObject<EventTarget | null>,
  environmentId: EnvironmentId,
  targetKey: string,
  onDrop: (refs: ReadonlyArray<ScopedThreadRef>, isActive: () => boolean) => void,
) {
  const handleDrop = useEffectEvent(onDrop);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes the target element to thread-context drop events and marks old drops inactive
  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    let active = true;
    const listener = (event: Event) =>
      handleDrop((event as CustomEvent<ReadonlyArray<ScopedThreadRef>>).detail, () => active);
    target.addEventListener(THREAD_CONTEXT_DROP_EVENT, listener);
    return () => {
      active = false;
      target.removeEventListener(THREAD_CONTEXT_DROP_EVENT, listener);
    };
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new environment or target ends the previous listener, so isActive reports false to drops still in flight for it.
    environmentId,
    targetKey,
    targetRef,
  ]);
}

const DROP_TARGET_ATTRIBUTE = "data-thread-context-drop";
const DROP_OVER_ATTRIBUTE = "data-thread-context-over";

export interface ThreadContextDragGhost {
  readonly x: number;
  readonly y: number;
  readonly count: number;
  /** The sidebar row's width, so the lifted row keeps its size. */
  readonly width?: number;
  readonly title?: string;
}

let ghost: ThreadContextDragGhost | null = null;
const listeners = new Set<() => void>();

function setGhost(next: ThreadContextDragGhost | null) {
  if (ghost === next) return;
  ghost = next;
  for (const listener of listeners) listener();
}

export function useThreadContextDragGhost(): ThreadContextDragGhost | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => ghost,
    () => null,
  );
}

let overTarget: HTMLElement | null = null;

type AcceptsDropTarget = (target: HTMLElement) => boolean;

// A layout drag covers the window with its own overlay while a thread is out
// of the list; the composer is the first element under it.
function findDropTarget(
  point: { x: number; y: number },
  accepts?: AcceptsDropTarget,
): HTMLElement | null {
  const element = document
    .elementsFromPoint(point.x, point.y)
    .find((candidate) => !candidate.closest("[data-layout-drag-overlay]"));
  const target = element?.closest<HTMLElement>(`[${DROP_TARGET_ATTRIBUTE}]`) ?? null;
  return target && accepts?.(target) !== false ? target : null;
}

/** Every composer on screen that takes a dropped thread. */
export function threadContextDropTargets(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[${DROP_TARGET_ATTRIBUTE}]`)];
}

/** Highlights the composer under the pointer and returns it. */
export function hoverThreadContextDrop(
  point: { x: number; y: number },
  accepts?: AcceptsDropTarget,
): HTMLElement | null {
  const target = findDropTarget(point, accepts);
  if (target !== overTarget) {
    overTarget?.removeAttribute(DROP_OVER_ATTRIBUTE);
    target?.setAttribute(DROP_OVER_ATTRIBUTE, "true");
    overTarget = target;
  }
  return target;
}

/**
 * Tracks the ghost and the highlighted drop target while the pointer is
 * outside the list. Returns the composer under the pointer.
 */
export function moveThreadContextDrag(
  point: { x: number; y: number },
  label: { count: number; width?: number; title?: string },
): HTMLElement | null {
  setGhost({ x: point.x, y: point.y, ...label });
  return hoverThreadContextDrop(point);
}

export function endThreadContextDrag() {
  overTarget?.removeAttribute(DROP_OVER_ATTRIBUTE);
  overTarget = null;
  setGhost(null);
}

export function dropThreadContext(
  point: { x: number; y: number },
  threads: ReadonlyArray<ScopedThreadRef>,
  accepts?: AcceptsDropTarget,
): boolean {
  const target = findDropTarget(point, accepts);
  if (!target || threads.length === 0) return false;
  target.dispatchEvent(new CustomEvent(THREAD_CONTEXT_DROP_EVENT, { detail: threads }));
  return true;
}

export function threadContextDropTargetProps() {
  return { [DROP_TARGET_ATTRIBUTE]: "true" } as const;
}
