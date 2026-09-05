import { autoAnimate, type AnimationController } from "@formkit/auto-animate";
import { useCallback, useLayoutEffect, useRef } from "react";

export const MAX_ANIMATED_SIDEBAR_THREAD_ROWS = 20;

interface ThreadListAnimation {
  node: HTMLElement;
  controller: AnimationController | null;
}

export function useSidebarThreadListAutoAnimate(visibleRowCount: number) {
  const animationRef = useRef<ThreadListAnimation | null>(null);
  const attach = useCallback((node: HTMLElement | null) => {
    if (!node) return;

    const animation: ThreadListAnimation = { node, controller: null };
    animationRef.current = animation;

    return () => {
      animation.controller?.destroy?.();
      animationRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const animation = animationRef.current;
    if (!animation) return;

    if (visibleRowCount > MAX_ANIMATED_SIDEBAR_THREAD_ROWS) {
      // disable() still reinserts removed nodes. Disconnect before mutation delivery instead.
      animation.controller?.destroy?.();
      animation.controller = null;
      return;
    }

    animation.controller ??= autoAnimate(animation.node, { duration: 180, easing: "ease-out" });
  });

  return attach;
}
