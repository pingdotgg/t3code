import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";

import type { DesktopNotificationTarget } from "@t3tools/contracts";

import { buildThreadRouteParams } from "../../threadRoutes";
import { useActiveThreadRefFromRoute } from "../ui/toast";
import { createDesktopNotificationTargetDrain } from "./desktopNotificationTarget.logic";

/**
 * Renders nothing; owns the two directions of desktop notification traffic for
 * as long as the app is mounted. Outbound: which thread is on screen, so the
 * main process can suppress a notification for that thread only. Inbound: a
 * clicked notification, as navigation.
 */
export function DesktopNotificationBootstrap() {
  const navigate = useNavigate();
  const activeThreadRef = useActiveThreadRefFromRoute();

  useEffect(() => {
    const reportActiveThread = window.desktopBridge?.reportActiveThread;
    if (typeof reportActiveThread !== "function") return;
    // Failures are diagnostics for main, not something the renderer can act on:
    // the worst case is one notification the user did not need.
    void reportActiveThread(activeThreadRef).catch(() => {});
  }, [activeThreadRef]);

  const openTarget = useEffectEvent((target: DesktopNotificationTarget) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(target),
    });
  });

  useEffect(() => {
    const bridge = window.desktopBridge;
    const consume = bridge?.consumePendingDesktopNotificationTarget;
    const subscribe = bridge?.onDesktopNotificationTargetAvailable;
    if (typeof consume !== "function" || typeof subscribe !== "function") return;

    const drain = createDesktopNotificationTargetDrain({
      consume: () => consume(),
      onTarget: openTarget,
      subscribe: (listener) => subscribe(listener),
    });

    return drain.dispose;
  }, [openTarget]);

  return null;
}
