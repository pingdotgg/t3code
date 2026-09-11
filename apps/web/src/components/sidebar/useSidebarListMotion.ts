import { useCallback, useLayoutEffect, useRef } from "react";

import { createSidebarListMotion } from "../Sidebar.motion";

/**
 * Animates a legacy sidebar list's rows into place with the default sidebar's
 * motion. `orderKey` names the rendered rows in order, empty when there are
 * none: a change runs one motion pass after the commit, and an idle list does
 * no work at all. The returned ref callback owns the motion and disposes it as
 * soon as the list detaches.
 */
export function useSidebarListMotion(orderKey: string) {
  const motionRef = useRef<ReturnType<typeof createSidebarListMotion> | null>(null);
  const attach = useCallback((node: HTMLUListElement | null) => {
    motionRef.current?.dispose();
    motionRef.current = node === null ? null : createSidebarListMotion(node);
    motionRef.current?.update(false);
  }, []);
  useLayoutEffect(() => {
    // An emptied list has nothing left to show a fade in, so it only resets
    // its baseline; that also keeps a collapse from cloning every row.
    motionRef.current?.update(orderKey !== "");
  }, [orderKey]);
  return attach;
}
