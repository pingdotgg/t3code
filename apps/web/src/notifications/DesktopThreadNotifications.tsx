import { useEffect, useRef } from "react";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import type { ClientSettings } from "@t3tools/contracts/settings";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type {
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";

import { isElectron } from "~/env";
import { getClientSettings, useClientSettings } from "~/hooks/useSettings";
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
import { playAlertChime } from "./alertSound";
import {
  clearThreadAlert,
  markThreadAlert,
  markThreadAlertsFocused,
  pruneExpiredThreadAlerts,
  readThreadAlerts,
  subscribeThreadAlerts,
  THREAD_ALERT_FOCUSED_TTL_MS,
  THREAD_ALERT_MAX_TTL_MS,
} from "./threadAlertStore";
import { reconcileWebPushRegistration } from "./webPush";

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
    // Resolved per batch, not once: the sound and the sidebar highlights work
    // without a desktop bridge, so a missing `showNotification` must not
    // disable them.
    let phases: ThreadPhaseSnapshot = EMPTY_THREAD_PHASE_SNAPSHOT;

    const reconcile = (threads: ReadonlyArray<EnvironmentThreadShell>) => {
      const settings = getClientSettings();
      const windowFocused = document.visibilityState === "visible" && document.hasFocus();
      const { notifications, playAlertSound, next } = reconcileThreadNotifications({
        previous: phases,
        threads,
        projectTitles: buildProjectTitleMap(readProjects()),
        settings: selectThreadNotificationSettings(settings),
        windowFocused,
        activeThreadRef: activeThreadRefMirror.current,
        readResponseText: readLoadedResponseText,
      });
      phases = next;

      const nowMs = Date.now();
      const showNotification = window.desktopBridge?.showNotification;
      for (const notification of notifications) {
        // Mark the row before the banner: the highlight is what survives Do
        // Not Disturb, so it must not depend on the banner succeeding.
        if (notification.kind === "task-completed" || notification.kind === "task-failed") {
          markThreadAlert(
            notification.threadRef,
            notification.kind === "task-failed" ? "failed" : "completed",
            { nowMs, windowFocused },
          );
        }

        if (typeof showNotification === "function") {
          void showNotification({
            kind: notification.kind,
            title: notification.title,
            body: notification.body,
            silent: !settings.desktopNotificationSound,
            threadRef: notification.threadRef,
          }).catch(() => undefined);
        }
      }

      // Played by the app itself rather than by the OS notification, which a
      // Focus mode would mute along with the banner.
      if (playAlertSound && settings.desktopNotificationSound) {
        playAlertChime();
      }
    };

    // Seed from the current shells before subscribing: everything already
    // loaded is recorded without firing, so a launch never replays a backlog.
    reconcile(readThreadShells());

    return appAtomRegistry.subscribe(environmentThreadShells.threadShellsAtom, reconcile);
  }, []);

  // Opening a thread is the user seeing it, so the highlight has done its job.
  useEffect(() => {
    if (activeThreadRef === null) {
      return;
    }
    clearThreadAlert(activeThreadRef);
  }, [activeThreadRef]);

  // Highlights are bounded twice over: they fade shortly after the window has
  // focus (the user is looking, so the signal has landed), and in any case
  // never outlive the hard ceiling. A single timer drives both, rather than
  // one per alert, and only runs while something is actually highlighted.
  useEffect(() => {
    const isFocused = () => document.visibilityState === "visible" && document.hasFocus();

    let timeoutId: number | null = null;

    const cancelPending = () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const scheduleNextPrune = () => {
      cancelPending();
      const alerts = readThreadAlerts();
      const deadlines: number[] = [];
      const nowMs = Date.now();

      for (const alert of Object.values(alerts)) {
        deadlines.push(alert.markedAtMs + THREAD_ALERT_MAX_TTL_MS);
        if (alert.focusedAtMs !== null) {
          deadlines.push(alert.focusedAtMs + THREAD_ALERT_FOCUSED_TTL_MS);
        }
      }
      if (deadlines.length === 0) {
        return;
      }

      const nextDeadline = Math.min(...deadlines);
      timeoutId = window.setTimeout(
        () => {
          timeoutId = null;
          pruneExpiredThreadAlerts(Date.now());
          scheduleNextPrune();
        },
        Math.max(0, nextDeadline - nowMs),
      );
    };

    const handleFocusChange = () => {
      if (isFocused()) {
        markThreadAlertsFocused(Date.now());
      }
      pruneExpiredThreadAlerts(Date.now());
      scheduleNextPrune();
    };

    window.addEventListener("focus", handleFocusChange);
    window.addEventListener("blur", scheduleNextPrune);
    document.addEventListener("visibilitychange", handleFocusChange);
    // New alerts arrive without a focus event, so reschedule when the set changes.
    const unsubscribe = subscribeThreadAlerts(handleFocusChange);
    handleFocusChange();

    return () => {
      cancelPending();
      unsubscribe();
      window.removeEventListener("focus", handleFocusChange);
      window.removeEventListener("blur", scheduleNextPrune);
      document.removeEventListener("visibilitychange", handleFocusChange);
    };
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

function WebPushRegistrationHost() {
  const settings = useClientSettings();
  const relaySession = useAtomValue(managedRelaySessionAtom);

  useEffect(() => {
    if (isElectron) {
      return;
    }
    void reconcileWebPushRegistration(settings).catch((error: unknown) => {
      console.error("[WEB_PUSH] subscription reconciliation failed", { error });
    });
  }, [
    relaySession?.accountId,
    settings.desktopNotificationSound,
    settings.desktopNotifyApprovalNeeded,
    settings.desktopNotifyTaskCompleted,
    settings.desktopNotifyTaskFailed,
    settings.webPushNotificationsEnabled,
  ]);

  return null;
}

/**
 * Alerts for agent task transitions: the native OS banner on desktop, plus the
 * chime and sidebar highlights that survive Do Not Disturb.
 *
 * Mounted everywhere, not just on desktop. The banner needs a desktop bridge
 * and is skipped without one, but the chime and highlights are plain web and
 * work in the browser too — gating the whole component on Electron would
 * discard them for no reason.
 */
export function DesktopThreadNotificationsHost() {
  return (
    <>
      <DesktopThreadNotifications />
      <WebPushRegistrationHost />
    </>
  );
}
