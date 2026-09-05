import { autoAnimate, type AnimationController } from "@formkit/auto-animate";
import { useCallback, useLayoutEffect, useRef } from "react";

export const MAX_ANIMATED_SIDEBAR_THREAD_ROWS = 20;

interface ThreadListAnimation {
  controller: AnimationController;
  visibleRowCount: number;
  pendingEnable: boolean;
}

export function useSidebarThreadListAutoAnimate(visibleRowCount: number) {
  const animationRef = useRef<ThreadListAnimation | null>(null);
  const attach = useCallback((node: HTMLElement | null) => {
    if (!node) return;

    const animation = {
      controller: autoAnimate(node, { duration: 180, easing: "ease-out" }),
      visibleRowCount: 0,
      pendingEnable: false,
    };
    animationRef.current = animation;

    return () => {
      animation.controller.destroy?.();
      animationRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const animation = animationRef.current;
    if (!animation) return;

    const previousRowCount = animation.visibleRowCount;
    animation.visibleRowCount = visibleRowCount;
    if (previousRowCount === visibleRowCount) return;
    if (
      previousRowCount <= MAX_ANIMATED_SIDEBAR_THREAD_ROWS &&
      visibleRowCount <= MAX_ANIMATED_SIDEBAR_THREAD_ROWS
    ) {
      if (!animation.pendingEnable) animation.controller.enable();
      return;
    }

    animation.controller.disable();
    if (visibleRowCount > MAX_ANIMATED_SIDEBAR_THREAD_ROWS || animation.pendingEnable) return;

    // MutationObserver must process the bulk removal before later small changes can animate.
    animation.pendingEnable = true;
    queueMicrotask(() => {
      animation.pendingEnable = false;
      if (
        animationRef.current === animation &&
        animation.visibleRowCount <= MAX_ANIMATED_SIDEBAR_THREAD_ROWS
      ) {
        animation.controller.enable();
      }
    });
  });

  return attach;
}
