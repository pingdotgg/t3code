import type { DesktopDeepLinkTarget } from "@t3tools/contracts";
import { useEffect } from "react";

import type { AppRouter } from "./router";

export function resolveDesktopDeepLinkNavigation(target: DesktopDeepLinkTarget) {
  return {
    to: "/$environmentId/$threadId" as const,
    params: {
      environmentId: target.environmentId,
      threadId: target.threadId,
    },
  };
}

export function DesktopDeepLinkHost({ router }: { readonly router: AppRouter }) {
  useEffect(() => {
    const onDeepLink = window.desktopBridge?.onDeepLink;
    if (typeof onDeepLink !== "function") return;

    return onDeepLink((target) => {
      void router.navigate(resolveDesktopDeepLinkNavigation(target));
    });
  }, [router]);

  return null;
}
