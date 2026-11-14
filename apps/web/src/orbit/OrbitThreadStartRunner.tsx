import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  orbitCompletionNeedsAdmission,
  orbitCompletionNeedsFollow,
} from "@t3tools/client-runtime/orbit-gateway";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

import { toastManager } from "../components/ui/toast";
import { buildThreadRouteParams } from "../threadRoutes";
import { useOrbitThreadsAvailable } from "./environmentProvider";
import { desktopOrbitGatewayClient } from "./OrbitProfileSync";
import { ORBIT_INSTANCE_STAYS_LINE, ORBIT_SETUP_CANCELLED_TITLE } from "./orbitSetupView";
import {
  followSavedOrbitCompletion,
  orbitPendingThreadPath,
  resumeSavedOrbitCompletionRetry,
  runSavedOrbitThreadStart,
} from "./orbitThreadStarts";
import { useOrbitThreadStarts } from "./orbitThreadStartStore";

/**
 * Runs the saved thread starts. Mounted once, in the main window, so no start runs twice. A start's
 * pending thread hands over and shows its error itself; elsewhere a toast does.
 */
export function OrbitThreadStartRunner() {
  const available = useOrbitThreadsAvailable();
  const starts = useOrbitThreadStarts((state) => state.starts);
  const navigate = useNavigate();
  const router = useRouter();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs each saved start that has not stopped
  useEffect(() => {
    const client = desktopOrbitGatewayClient();
    if (!available || client === null) return;
    for (const start of starts) {
      // The create's completion runs on after the send; the thread's card follows it.
      if (orbitCompletionNeedsFollow(start)) void followSavedOrbitCompletion(client, start.id);
      if (orbitCompletionNeedsAdmission(start)) {
        void resumeSavedOrbitCompletionRetry(client, start.id);
      }
      // A sent start is kept only for its thread's ready row.
      if (start.error !== null || (start.sentAt != null && start.pendingThread)) continue;
      void runSavedOrbitThreadStart(client, start.id, {
        onCancelled: () =>
          toastManager.add({
            type: "info",
            title: ORBIT_SETUP_CANCELLED_TITLE,
            description: ORBIT_INSTANCE_STAYS_LINE,
          }),
      }).then((sent) => {
        if (router.state.location.pathname === orbitPendingThreadPath(start.id)) return;
        if (sent !== null) {
          const id = toastManager.add({
            type: "success",
            title: `Thread started in ${start.projectSlug}`,
            actionProps: {
              children: "Open",
              onClick: () => {
                toastManager.close(id);
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(scopeThreadRef(sent.environmentId, sent.threadId)),
                });
              },
            },
          });
          return;
        }
        const stopped = useOrbitThreadStarts
          .getState()
          .starts.find((entry) => entry.id === start.id);
        if (stopped?.error) {
          toastManager.add({
            type: "error",
            title: `Could not start the thread in ${stopped.projectSlug}`,
            description: stopped.error,
          });
        }
      });
    }
  }, [available, navigate, router, starts]);

  return null;
}
