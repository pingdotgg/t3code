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
  readonly title: string;
  readonly count: number;
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

function findDropTarget(point: { x: number; y: number }): HTMLElement | null {
  return (
    document
      .elementFromPoint(point.x, point.y)
      ?.closest<HTMLElement>(`[${DROP_TARGET_ATTRIBUTE}]`) ?? null
  );
}

export function moveThreadContextDrag(
  point: { x: number; y: number },
  label: { title: string; count: number },
) {
  const target = findDropTarget(point);
  if (target !== overTarget) {
    overTarget?.removeAttribute(DROP_OVER_ATTRIBUTE);
    target?.setAttribute(DROP_OVER_ATTRIBUTE, "true");
    overTarget = target;
  }
  setGhost({ x: point.x, y: point.y, ...label });
}

export function endThreadContextDrag() {
  overTarget?.removeAttribute(DROP_OVER_ATTRIBUTE);
  overTarget = null;
  setGhost(null);
}

export function dropThreadContext(
  point: { x: number; y: number },
  threads: ReadonlyArray<ScopedThreadRef>,
): boolean {
  const target = findDropTarget(point);
  if (!target || threads.length === 0) return false;
  target.dispatchEvent(new CustomEvent(THREAD_CONTEXT_DROP_EVENT, { detail: threads }));
  return true;
}

export function threadContextDropTargetProps() {
  return { [DROP_TARGET_ATTRIBUTE]: "true" } as const;
}
