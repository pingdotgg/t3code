import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { useSettings } from "./useSettings";
import { sendLocalNotification } from "../lib/localNotifications";
import {
  cloneThreadSnapshot,
  collectLifecycleNotifications,
  type NotificationThreadSnapshot,
} from "../lifecycleNotifications";

function isAppInForeground(): boolean {
  if (typeof document === "undefined") {
    return true;
  }
  return document.visibilityState === "visible" && document.hasFocus();
}

export function useLifecycleNotifications(): void {
  const threads = useStore((store) => store.threads);
  const projects = useStore((store) => store.projects);
  const settings = useSettings();
  const attentionNotifications = settings.attentionNotifications;
  const previousThreadsRef = useRef<NotificationThreadSnapshot[]>([]);
  const initializedRef = useRef(false);

  useEffect(() => {
    const nextThreadSnapshot = threads.map((thread) => cloneThreadSnapshot(thread));

    if (!initializedRef.current) {
      previousThreadsRef.current = nextThreadSnapshot;
      initializedRef.current = true;
      return;
    }

    if (!attentionNotifications) {
      previousThreadsRef.current = nextThreadSnapshot;
      return;
    }

    const notifications = collectLifecycleNotifications({
      previousThreads: previousThreadsRef.current,
      nextThreads: nextThreadSnapshot,
      projects,
    });
    previousThreadsRef.current = nextThreadSnapshot;

    if (notifications.length === 0 || isAppInForeground()) {
      return;
    }

    for (const notification of notifications) {
      sendLocalNotification({
        title: notification.title,
        body: notification.body,
        tag: notification.id,
      });
    }
  }, [attentionNotifications, projects, threads]);
}
