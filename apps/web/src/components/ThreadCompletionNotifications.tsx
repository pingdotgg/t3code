import { useEffect, useMemo, useRef } from "react";
import { useRouter } from "@tanstack/react-router";
import { projectKey } from "@t3tools/client-runtime/state/entities";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useClientSettings } from "~/hooks/useSettings";
import { showNotification, useNotificationPermission } from "~/notificationPermission";
import { playNotificationChime, primeNotificationChime } from "~/notificationChime";
import { useProjects, useThreadShells } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import {
  deriveThreadCompletionNotifications,
  NO_OBSERVED_THREADS,
  type ObservedThreads,
  type ThreadCompletionNotification,
} from "~/threadCompletionNotifications.logic";

/**
 * Raises an OS notification when a thread finishes its turn.
 *
 * Belongs in the app shell rather than the chat route: a turn that finishes
 * while the user is in Settings should still reach them, and remounting would
 * re-seed the watcher and swallow it.
 */
export function ThreadCompletionNotifications() {
  const enabled = useClientSettings((settings) => settings.threadCompletionNotifications);
  const { permission } = useNotificationPermission();

  // Nothing below this line subscribes to thread updates until the user has
  // both opted in and granted permission.
  if (!enabled || permission !== "granted") return null;
  return <ThreadCompletionWatcher />;
}

function ThreadCompletionWatcher() {
  const soundEnabled = useClientSettings((settings) => settings.threadCompletionNotificationSound);
  const volume = useClientSettings((settings) => settings.threadCompletionNotificationVolume);
  const threads = useThreadShells();
  const projects = useProjects();
  const router = useRouter();
  const observed = useRef<ObservedThreads>(NO_OBSERVED_THREADS);

  const projectTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const project of projects) {
      titles.set(projectKey(scopeProjectRef(project.environmentId, project.id)), project.title);
    }
    return titles;
  }, [projects]);

  // A reload leaves the audio context locked until the page sees a gesture,
  // and the user has no reason to open Settings again to unlock it.
  useEffect(() => {
    if (!soundEnabled) return;
    const unlock = () => primeNotificationChime();
    const options = { capture: true, once: true } as const;
    window.addEventListener("pointerdown", unlock, options);
    window.addEventListener("keydown", unlock, options);
    return () => {
      window.removeEventListener("pointerdown", unlock, options);
      window.removeEventListener("keydown", unlock, options);
    };
  }, [soundEnabled]);

  useEffect(() => {
    const result = deriveThreadCompletionNotifications({ threads, observed: observed.current });
    observed.current = result.observed;

    let delivered = 0;
    for (const notification of result.notifications) {
      if (show(notification, projectTitles, router)) delivered += 1;
    }

    // One chime for the batch: two threads settling in the same snapshot
    // should not stack two sounds.
    if (soundEnabled && delivered > 0) {
      playNotificationChime(volume);
    }
  }, [projectTitles, router, soundEnabled, threads, volume]);

  return null;
}

function show(
  notification: ThreadCompletionNotification,
  projectTitles: ReadonlyMap<string, string>,
  router: ReturnType<typeof useRouter>,
): boolean {
  const threadRef = scopeThreadRef(notification.environmentId, notification.threadId);
  const projectTitle = projectTitles.get(
    projectKey(scopeProjectRef(notification.environmentId, notification.projectId)),
  );

  return showNotification({
    title: notification.title,
    body: projectTitle ? `${projectTitle} · Turn finished` : "Turn finished",
    // Turn-scoped: replacing a thread's earlier card would re-render it
    // without re-alerting, which is the one thing this must not do.
    tag: `t3code-thread-complete:${notification.turnId}`,
    onClick: () => {
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
  });
}
