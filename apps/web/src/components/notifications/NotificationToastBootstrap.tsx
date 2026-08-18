import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, NotificationDecidedEdge } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { notificationEnvironment, primaryNotificationEdgesAtom } from "../../state/notifications";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { primaryServerSettingsAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { stackedThreadToast, toastManager, useActiveThreadRefFromRoute } from "../ui/toast";
import {
  decideNotificationToast,
  notificationToastContent,
  notificationToastType,
} from "./notificationToast.logic";

type ToastId = ReturnType<typeof toastManager.add>;

/**
 * How many identity keys the duplicate filter remembers. Module-level, so a
 * remount of this component (a route transition, a hot reload) cannot re-toast
 * or re-report an edge it already handled.
 */
const MAX_HANDLED_IDENTITY_KEYS = 512;
const handledIdentityKeys = new Set<string>();

function markHandled(identityKey: string): void {
  handledIdentityKeys.add(identityKey);
  while (handledIdentityKeys.size > MAX_HANDLED_IDENTITY_KEYS) {
    const oldest = handledIdentityKeys.values().next();
    if (oldest.done === true) return;
    handledIdentityKeys.delete(oldest.value);
  }
}

function readAppFocused(): boolean {
  if (typeof document === "undefined") {
    // Nothing to be focused on yet, so nothing is suppressed — one toast too
    // many beats a silently dropped notification.
    return false;
  }
  return document.visibilityState === "visible" && document.hasFocus();
}

function useAppFocused(): boolean {
  const [appFocused, setAppFocused] = useState(readAppFocused);

  useEffect(() => {
    const sync = () => {
      setAppFocused(readAppFocused());
    };
    sync();
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  return appFocused;
}

/**
 * The web notification transport: in-app toasts for decided edges, and a report
 * back for each one.
 *
 * v1 is toasts only. The browser Notification API is a future transport, and the
 * per-transport policy split means adding it is purely additive — it would read
 * the same stream and report under its own transport name.
 */
export function NotificationToastBootstrap() {
  const navigate = useNavigate();
  const edges = useAtomValue(primaryNotificationEdgesAtom);
  const notificationsEnabled = useAtomValue(primaryServerSettingsAtom).notificationsEnabled;
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const activeThreadRef = useActiveThreadRefFromRoute();
  const appFocused = useAppFocused();
  const reportTransportOutcome = useAtomCommand(notificationEnvironment.reportTransportOutcome, {
    reportFailure: false,
  });

  const openThread = useCallback(
    (targetEnvironmentId: EnvironmentId, edge: NotificationDecidedEdge) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(targetEnvironmentId, edge.threadId)),
      });
    },
    [navigate],
  );

  useEffect(() => {
    if (primaryEnvironmentId === null) {
      return;
    }
    for (const edge of edges) {
      const decision = decideNotificationToast({
        edge,
        environmentId: primaryEnvironmentId,
        notificationsEnabled,
        appFocused,
        activeThreadRef,
        alreadyHandled: handledIdentityKeys.has(edge.identityKey),
      });
      if (decision.action === "skip") {
        continue;
      }

      // Recorded before the toast so a render that throws cannot loop on the
      // same edge, and before the report so the resume cursor can never move
      // past an edge this transport did not handle.
      markHandled(edge.identityKey);
      notificationEnvironment.recordPresentedSequence(
        primaryEnvironmentId,
        edge.triggeringSequence,
      );

      if (decision.action === "show") {
        const content = notificationToastContent(edge);
        let toastId!: ToastId;
        toastId = toastManager.add(
          stackedThreadToast({
            type: notificationToastType(edge.kind),
            title: content.title,
            description: content.description,
            actionProps: {
              children: "Open",
              onClick: () => {
                toastManager.close(toastId);
                openThread(primaryEnvironmentId, edge);
              },
            },
            actionVariant: "outline",
            // No `threadRef`/`threadId` in `data`: thread-scoped toasts render
            // only *on* that thread, which is the exact inverse of the focus
            // rule this transport implements.
            data: { hideCopyButton: true },
          }),
        );
      }

      void reportTransportOutcome({
        environmentId: primaryEnvironmentId,
        input: {
          identityKey: edge.identityKey,
          transportName: "web",
          outcome: decision.outcome,
        },
      });
    }
  }, [
    activeThreadRef,
    appFocused,
    edges,
    notificationsEnabled,
    openThread,
    primaryEnvironmentId,
    reportTransportOutcome,
  ]);

  return null;
}
