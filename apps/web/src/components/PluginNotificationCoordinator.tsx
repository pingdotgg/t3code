import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  pluginNotificationChanges,
  pluginNotificationDescription,
  type PluginNotificationMark,
} from "@t3tools/client-runtime/state/plugin-notifications";
import { useEffect, useRef } from "react";

import { useEnvironmentIds } from "../state/environments";
import { usePluginNotificationFrame } from "../state/pluginNotifications";
import { toastManager } from "./ui/toast";

/**
 * Shows plugin notifications as toasts, for every environment whose server
 * supports them. Only notifications that arrive while the app is open are
 * shown; a toast closes once the server no longer retains its notification
 * (its plugin stopped, it expired or was evicted, or the server restarted)
 * or its environment is removed.
 */
export function PluginNotificationCoordinator() {
  const environmentIds = useEnvironmentIds();
  return environmentIds.map((environmentId) => (
    <EnvironmentPluginNotifications key={environmentId} environmentId={environmentId} />
  ));
}

function EnvironmentPluginNotifications({ environmentId }: { environmentId: EnvironmentId }) {
  const frame = usePluginNotificationFrame(environmentId);
  const navigate = useNavigate();
  // All this keeps: the newest notification seen, and the toasts still open.
  const mark = useRef<PluginNotificationMark | undefined>(undefined);
  const toasts = useRef(new Map<string, ReturnType<typeof toastManager.add>>());

  // Unmounting means the environment was removed, so no later frame will close its toasts.
  useEffect(() => {
    const open = toasts.current;
    return () => {
      for (const toastId of open.values()) toastManager.close(toastId);
      open.clear();
    };
  }, []);

  useEffect(() => {
    const changes = pluginNotificationChanges(mark.current, frame);
    mark.current = changes.mark;
    for (const [key, toastId] of toasts.current) {
      if (changes.keep.has(key)) continue;
      toasts.current.delete(key);
      toastManager.close(toastId);
    }
    for (const entry of changes.show) {
      const { threadId, title, tone } = entry.notification;
      const toastId = toastManager.add({
        ...(tone === undefined || tone === "neutral" ? {} : { type: tone }),
        title,
        description: pluginNotificationDescription(entry),
        data: { hideCopyButton: true },
        ...(threadId === undefined
          ? {}
          : {
              actionProps: {
                children: "Open thread",
                onClick: () => {
                  toastManager.close(toastId);
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId, threadId },
                  });
                },
              },
            }),
      });
      toasts.current.set(entry.key, toastId);
    }
  }, [environmentId, frame, navigate]);

  return null;
}
