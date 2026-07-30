import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

/**
 * Routes `t3code://` links the desktop app hands over.
 *
 * Must be mounted by an always-rendered component: the desktop side pushes a
 * link as soon as it arrives, and a listener that only exists on some routes
 * would drop links that land while the pairing or sign-in screens are showing.
 *
 * Pulls once on mount as well, because a link handed over on the command line is
 * captured before any renderer exists to receive a push.
 */
export function useDesktopDeepLinks(): void {
  const navigate = useNavigate();

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge) {
      return;
    }

    let unmounted = false;
    // `href` rather than `to`: a link carries a fully built path, and only the
    // href form splits the query and fragment back out for the router.
    const go = (target: string) => {
      void navigate({ href: target });
    };

    const takePendingDeepLink = bridge.takePendingDeepLink;
    if (typeof takePendingDeepLink === "function") {
      void takePendingDeepLink()
        .then((target) => {
          if (!unmounted && target !== null) {
            go(target);
          }
        })
        .catch(() => undefined);
    }

    const unsubscribe = bridge.onDeepLink?.(go);

    return () => {
      unmounted = true;
      unsubscribe?.();
    };
  }, [navigate]);
}
