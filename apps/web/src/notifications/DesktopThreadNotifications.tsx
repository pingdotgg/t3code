import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ClientSettings } from "@t3tools/contracts/settings";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type {
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";

import { isElectron } from "~/env";
import { getClientSettings } from "~/hooks/useSettings";
import { useActiveThreadRefFromRoute } from "~/hooks/useActiveThreadRef";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentThreadDetails, environmentThreadShells } from "~/state/threads";
import { readProjects, readThreadShells } from "~/state/entities";
import {
  buildProjectTitleMap,
  reconcileThreadNotifications,
  EMPTY_THREAD_PHASE_SNAPSHOT,
  type ThreadNotificationSettings,
  type ThreadPhaseSnapshot,
} from "./desktopNotifications.logic";

/**
 * Latest assistant text for a thread, but only when that thread's detail atom
 * is already live in the registry.
 *
 * Reading `detailAtom` through `registry.get` would *mount* it, and a thread
 * detail atom is stream-backed: doing that for every thread in the sidebar
 * would open a websocket subscription per thread purely to caption a
 * notification. Peeking at existing nodes keeps this free, and the body falls
 * back to the thread title whenever nothing is loaded.
 */
function readLoadedResponseText(ref: ScopedThreadRef): string | null {
  const atom = environmentThreadDetails.detailAtom(ref);
  const node = appAtomRegistry.getNodes().get(atom);
  if (node === undefined || node.currentState() !== "valid") {
    return null;
  }

  const detail = node.value() as EnvironmentThread | null;
  const messages = detail?.messages;
  if (messages === undefined) {
    return null;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && message.text.trim().length > 0) {
      return message.text;
    }
  }
  return null;
}

export function selectThreadNotificationSettings(
  settings: ClientSettings,
): ThreadNotificationSettings {
  return {
    enabled: settings.desktopNotificationsEnabled,
    taskCompleted: settings.desktopNotifyTaskCompleted,
    taskFailed: settings.desktopNotifyTaskFailed,
    approvalNeeded: settings.desktopNotifyApprovalNeeded,
  };
}

function DesktopThreadNotifications() {
  const navigate = useNavigate();
  const activeThreadRef = useActiveThreadRefFromRoute();
  // Mirrored into a ref so the atom subscription below can read the current
  // route without re-subscribing on every navigation.
  const activeThreadRefMirror = useRef(activeThreadRef);
  activeThreadRefMirror.current = activeThreadRef;

  useEffect(() => {
    const showNotification = window.desktopBridge?.showNotification;
    if (typeof showNotification !== "function") {
      return;
    }

    let phases: ThreadPhaseSnapshot = EMPTY_THREAD_PHASE_SNAPSHOT;

    const reconcile = (threads: ReadonlyArray<EnvironmentThreadShell>) => {
      const settings = getClientSettings();
      const { notifications, next } = reconcileThreadNotifications({
        previous: phases,
        threads,
        projectTitles: buildProjectTitleMap(readProjects()),
        settings: selectThreadNotificationSettings(settings),
        windowFocused: document.visibilityState === "visible" && document.hasFocus(),
        activeThreadRef: activeThreadRefMirror.current,
        readResponseText: readLoadedResponseText,
      });
      phases = next;

      for (const notification of notifications) {
        void showNotification({
          kind: notification.kind,
          title: notification.title,
          body: notification.body,
          silent: !settings.desktopNotificationSound,
          threadRef: notification.threadRef,
        }).catch(() => undefined);
      }
    };

    // Seed from the current shells before subscribing: everything already
    // loaded is recorded without firing, so a launch never replays a backlog.
    reconcile(readThreadShells());

    return appAtomRegistry.subscribe(environmentThreadShells.threadShellsAtom, reconcile);
  }, []);

  useEffect(() => {
    const onNotificationActivated = window.desktopBridge?.onNotificationActivated;
    if (typeof onNotificationActivated !== "function") {
      return;
    }

    const unsubscribe = onNotificationActivated(({ threadRef }) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: threadRef.environmentId,
          threadId: threadRef.threadId,
        },
      });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  return null;
}

/**
 * Native OS notifications for agent task transitions. Desktop-only: without a
 * desktop bridge there is nothing to raise a notification with, so the whole
 * subtree stays unmounted on web.
 */
export function DesktopThreadNotificationsHost() {
  return isElectron ? <DesktopThreadNotifications /> : null;
}
