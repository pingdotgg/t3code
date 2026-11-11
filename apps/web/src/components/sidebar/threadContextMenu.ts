import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

export interface ThreadContextMenuOptions {
  // Surfaces that show the title themselves rename in place instead of in the sidebar row.
  readonly onStartRename?: (threadRef: ScopedThreadRef, title: string) => void;
}

type ThreadContextMenuHandler = (
  threadRef: ScopedThreadRef,
  position: { x: number; y: number },
  options?: ThreadContextMenuOptions,
) => void;

// The menu's actions live in the sidebar, which owns rename, project filter and selection state.
let handler: ThreadContextMenuHandler | null = null;

export function useProvideThreadContextMenu(provided: ThreadContextMenuHandler) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the mounted sidebar's menu to other surfaces
  useEffect(() => {
    handler = provided;
    return () => {
      if (handler === provided) handler = null;
    };
  }, [provided]);
}

/** Opens the sidebar's thread menu; false when no sidebar is mounted to serve it. */
export function showThreadContextMenu(
  threadRef: ScopedThreadRef,
  position: { x: number; y: number },
  options?: ThreadContextMenuOptions,
): boolean {
  if (handler === null) return false;
  handler(threadRef, position, options);
  return true;
}
