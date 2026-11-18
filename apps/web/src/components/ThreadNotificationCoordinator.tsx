import { msg } from "gt-react";
import { m } from "../i18n/messages";
import {
  type EnvironmentThreadShell,
  type PendingSubagentRequest,
  presentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import type { AnyRouter } from "@tanstack/react-router";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import type {
  AgentAlert,
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { monitorHoldsWakeCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import type { ClientSettings } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";
import {
  BellIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { getClientSettings, subscribeClientSettings } from "../hooks/useSettings";
import { isWindowsPlatform } from "../lib/utils";
import { environmentSummaries } from "../state/presentation";
import { serverEnvironment } from "../state/server";
import { environmentShell } from "../state/shell";
import { environmentThreadShells } from "../state/threads";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  setNotificationBadge,
  threadNotificationTag,
  unlockNotificationAudio,
} from "../threadNotifications";
import { resolveBackgroundThreadRequest } from "./backgroundThreadAnnouncement";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "./Sidebar.logic";
import {
  createThreadNotificationGate,
  isSnoozedForNotification,
  type ThreadNotificationKind,
  type ThreadNotificationObservation,
} from "./ThreadNotificationCoordinator.logic";
import { toastManager } from "./ui/toast";

interface NotificationState extends ThreadNotificationObservation {
  readonly raw: OrchestrationV2ThreadShell;
  readonly subagentRequest: PendingSubagentRequest | null;
  readonly thread: EnvironmentThreadShell;
  readonly status: SidebarThreadStatus;
}

type ToastId = ReturnType<typeof toastManager.add>;

interface WatchedEnvironment {
  unsubscribe: () => void;
  previous: Map<ThreadId, NotificationState>;
  reconnecting: boolean;
  readonly gate: ReturnType<typeof createThreadNotificationGate<ThreadId>>;
}

/**
 * Turns thread status transitions in every connected environment into sounds, in-app toasts,
 * and desktop notifications, and keeps the dock badge in step with the unread ones.
 */
export function startThreadNotifications(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
): () => void {
  const pending = new Map<
    string,
    { environmentId: EnvironmentId; threadId: ThreadId; notification: Notification }
  >();
  const watched = new Map<EnvironmentId, WatchedEnvironment>();

  const trackNotification = (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    notification: Notification,
  ) => {
    pending.get(notification.tag)?.notification.close();
    pending.set(notification.tag, { environmentId, threadId, notification });
    setNotificationBadge(pending.size);
  };
  // Toast ids by thread key, so hiding or opening a thread, or removing its environment, closes them.
  const openToasts = new Map<string, Array<ToastId>>();
  const forgetToast = (key: string, toastId: ToastId) => {
    const remaining = (openToasts.get(key) ?? []).filter((id) => id !== toastId);
    if (remaining.length === 0) openToasts.delete(key);
    else openToasts.set(key, remaining);
  };
  const closeToasts = (shouldClose: (key: string) => boolean) => {
    for (const [key, toastIds] of openToasts) {
      if (!shouldClose(key)) continue;
      for (const toastId of toastIds) toastManager.close(toastId);
      openToasts.delete(key);
    }
  };
  const activeThread = () =>
    (router.state.matches.at(-1)?.params ?? {}) as {
      environmentId?: EnvironmentId;
      threadId?: ThreadId;
    };
  const closeOpenedThreadToasts = () => {
    const { environmentId, threadId } = activeThread();
    if (environmentId === undefined || threadId === undefined) return;
    const opened = threadKey({ environmentId, threadId });
    closeToasts((key) => key === opened);
  };
  // A notification shown before the tag filter turned on must not stay on screen. While hiding,
  // one whose thread left the live list (archived) cannot be judged, so it closes too.
  const closeHiddenPending = () => {
    const hidden = registry.get(environmentThreadShells.hiddenThreadKeysAtom);
    const live = registry.get(environmentThreadShells.anyEnvironmentHidingAtom)
      ? new Set(registry.get(environmentThreadShells.threadRefsAtom).map(threadKey))
      : null;
    const shouldClose = (key: string) => hidden.has(key) || (live !== null && !live.has(key));
    closeToasts(shouldClose);
    const count = pending.size;
    for (const [tag, entry] of pending) {
      if (!shouldClose(threadKey(entry))) continue;
      entry.notification.close();
      pending.delete(tag);
    }
    if (count !== pending.size) setNotificationBadge(pending.size);
  };
  const clearPending = () => {
    for (const { notification } of pending.values()) notification.close();
    pending.clear();
    setNotificationBadge(0);
  };

  const show = (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    presentation: {
      readonly title: string;
      readonly body: string;
      readonly sound: ThreadNotificationKind;
      readonly toastType: "success" | "error" | "warning" | "info";
      readonly icon: ReactNode;
      readonly tag: string;
      readonly requireInteraction: boolean;
    },
  ) => {
    if (
      registry
        .get(environmentThreadShells.hiddenThreadKeysAtom)
        .has(threadKey({ environmentId, threadId }))
    )
      return;
    const { notificationMode: mode, inAppNotificationsEnabled } = getClientSettings();
    const active = activeThread();
    if (hasNotificationSound(mode)) {
      void playNotificationSound(presentation.sound, () =>
        hasNotificationSound(getClientSettings().notificationMode),
      );
    }
    const openThread = () =>
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId },
      });
    if (
      inAppNotificationsEnabled &&
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      (active.environmentId !== environmentId || active.threadId !== threadId)
    ) {
      const toastKey = threadKey({ environmentId, threadId });
      const toastId: ToastId = toastManager.add({
        onRemove: (): void => forgetToast(toastKey, toastId),
        type: presentation.toastType,
        title: presentation.title,
        description: presentation.body,
        data: { hideCopyButton: true, leadingIcon: presentation.icon },
        actionProps: {
          children: m(msg("Open thread")),
          onClick: () => {
            toastManager.close(toastId);
            openThread();
          },
        },
      });
      openToasts.set(toastKey, [...(openToasts.get(toastKey) ?? []), toastId]);
      return;
    }
    if (
      !hasDesktopNotifications(mode) ||
      (document.visibilityState === "visible" && document.hasFocus()) ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    )
      return;
    try {
      const notification = new Notification(presentation.title, {
        body: presentation.body,
        tag: presentation.tag,
        silent: true,
        requireInteraction: presentation.requireInteraction,
      });
      trackNotification(environmentId, threadId, notification);
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        void window.desktopBridge?.revealWindow().catch(() => undefined);
        openThread();
      });
    } catch {
      // Some browsers expose Notification but reject desktop presentation.
    }
  };

  const present = (
    environmentId: EnvironmentId,
    state: NotificationState,
    kind: ThreadNotificationKind,
  ) => {
    const { thread, status } = state;
    show(environmentId, thread.id, {
      title:
        kind === "completion"
          ? m(msg("Thread completed"))
          : status === "approval"
            ? m(msg("Approval needed"))
            : status === "limited"
              ? m(msg("Usage limit reached"))
              : status === "failed"
                ? m(msg("Thread failed"))
                : status === "request"
                  ? m(msg("Guest request"))
                  : m(msg("Input needed")),
      body: thread.title,
      sound: kind,
      toastType: kind === "completion" ? "success" : status === "failed" ? "error" : "warning",
      icon:
        kind === "completion" ? (
          <CircleCheckIcon aria-hidden className="size-4 text-success-foreground" />
        ) : status === "approval" ? (
          <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
        ) : status === "limited" ? (
          <CircleAlertIcon aria-hidden className="size-4 text-warning-foreground" />
        ) : status === "failed" ? (
          <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
        ) : (
          <MessageCircleQuestionIcon aria-hidden className="size-4 text-info-foreground" />
        ),
      tag: threadNotificationTag(environmentId, thread.id),
      // Windows drops clicks after a toast moves into Notification Center.
      requireInteraction: kind === "completion" && isWindowsPlatform(navigator.platform),
    });
  };

  // An agent's own message, sent while its thread is still running, so no status change announces it.
  const presentAgentAlert = (environmentId: EnvironmentId, alert: AgentAlert, title: string) => {
    const active = activeThread();
    if (
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      active.environmentId === environmentId &&
      active.threadId === alert.threadId
    )
      return;
    show(environmentId, alert.threadId, {
      title,
      body: alert.body,
      sound: "input",
      toastType: "info",
      icon: <BellIcon aria-hidden className="size-4 text-info-foreground" />,
      // Its own tag, so the thread's next status notification does not replace the message.
      tag: `${threadNotificationTag(environmentId, alert.threadId)}:alert`,
      requireInteraction: false,
    });
  };

  const observeThreads = (
    environmentId: EnvironmentId,
    entry: WatchedEnvironment,
    threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) => {
    const previous = entry.previous;
    const next = new Map<ThreadId, NotificationState>();
    // A parent here also hears of what its tasks on linked environments ask.
    const subagentRequests = registry.get(
      environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
    );
    const delegatedUnderParent = registry.get(environmentThreadShells.delegatedUnderParentAtom);
    const changed: Array<[NotificationState | undefined, NotificationState]> = [];
    for (const rawThread of threads) {
      if (
        isShownUnderParent(
          { environmentId, threadId: rawThread.id },
          rawThread.lineage,
          delegatedUnderParent,
        )
      ) {
        continue;
      }
      const prior = previous.get(rawThread.id);
      const subagentRequest = subagentRequests.get(rawThread.id) ?? null;
      if (
        !entry.reconnecting &&
        prior?.raw === rawThread &&
        prior.subagentRequest === subagentRequest
      ) {
        next.set(rawThread.id, prior);
        continue;
      }
      const thread = presentThreadShell(environmentId, rawThread, subagentRequest);
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
      const needsAttention =
        status === "input" ||
        status === "request" ||
        status === "approval" ||
        status === "failed" ||
        status === "limited";
      const requestId = needsAttention ? resolveBackgroundThreadRequest(thread).requestId : null;
      // Queued messages become the latest run while a request stays pending, so a request
      // with an id is keyed by that id alone and announces once.
      const attention = !needsAttention
        ? null
        : requestId !== null
          ? `${status}:${requestId}`
          : `${thread.latestRun?.runId ?? ""}:${status}`;
      const completed = status === "ready" && thread.latestRun?.status === "completed";
      const settled = completed && !monitorHoldsWakeCompletion(rawThread);
      const parsedCompletedAt = Date.parse(thread.latestRun?.completedAt ?? "");
      const completedAt = Number.isFinite(parsedCompletedAt) ? parsedCompletedAt : null;
      const state = {
        raw: rawThread,
        subagentRequest,
        thread,
        status,
        attention,
        requestId,
        settled,
        completedAt: settled ? completedAt : null,
        backgroundWake: rawThread.latestRunBackgroundWake === true,
      };
      next.set(thread.id, state);
      changed.push([prior, state]);
    }
    entry.reconnecting = false;
    entry.previous = next;
    entry.gate.retain(new Set(next.keys()));
    const now = Date.now();
    for (const [prior, state] of changed) {
      entry.gate.observe(state.thread.id, prior, state, {
        archived: state.thread.archivedAt !== null,
        quiet: state.raw.latestRunStopRequested === true,
        snoozed: isSnoozedForNotification(state.thread, state.completedAt, now),
      });
    }
  };

  const watchEnvironment = (environmentId: EnvironmentId): WatchedEnvironment => {
    const entry: WatchedEnvironment = {
      previous: new Map(),
      reconnecting: false,
      unsubscribe: () => {},
      gate: createThreadNotificationGate<ThreadId>((threadId, kind) => {
        const state = entry.previous.get(threadId);
        if (state) present(environmentId, state, kind);
      }),
    };
    let threads: ReadonlyArray<OrchestrationV2ThreadShell> | null = null;
    const unsubscribeShell = registry.subscribe(
      environmentShell.stateValueAtom(environmentId),
      (shell) => {
        threads =
          shell.status === "live" && Option.isSome(shell.snapshot)
            ? shell.snapshot.value.threads
            : null;
        if (threads !== null) {
          observeThreads(environmentId, entry, threads);
          return;
        }
        entry.reconnecting = true;
        entry.gate.pause();
      },
      { immediate: true },
    );
    const reobserve = () => {
      if (threads !== null) observeThreads(environmentId, entry, threads);
    };
    const unsubscribeRequests = registry.subscribe(
      environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
      reobserve,
    );
    const unsubscribeDelegated = registry.subscribe(
      environmentThreadShells.delegatedUnderParentAtom,
      reobserve,
    );
    const subscribeAlerts = () => {
      // The atom keeps its last alert, so the one it holds on subscribing is old, and each id
      // is shown once.
      let shownAlertId: string | null | undefined;
      return registry.subscribe(
        serverEnvironment.agentAlerts({ environmentId, input: {} }),
        (result) => {
          // Every value of a stream that is still open is `waiting`, so that flag says nothing here.
          const alert = AsyncResult.isSuccess(result) ? result.value : null;
          const seen = shownAlertId;
          shownAlertId = alert?.id ?? null;
          if (seen === undefined || alert === null || alert.id === seen) return;
          const thread = threads?.find((candidate) => candidate.id === alert.threadId);
          // An archived thread never notifies, and archiving takes it off the live list.
          if (thread === undefined || thread.archivedAt !== null) return;
          presentAgentAlert(environmentId, alert, thread.title || "T3 Code");
        },
        { immediate: true },
      );
    };
    // Older servers do not serve the stream, so follow it only where it is advertised.
    let unsubscribeAlerts: (() => void) | null = null;
    const unsubscribeConfig = registry.subscribe(
      serverEnvironment.configValueAtom(environmentId),
      (config) => {
        const advertised = config?.environment.capabilities.agentAlerts === true;
        if (advertised === (unsubscribeAlerts !== null)) return;
        unsubscribeAlerts?.();
        unsubscribeAlerts = advertised ? subscribeAlerts() : null;
      },
      { immediate: true },
    );
    entry.unsubscribe = () => {
      unsubscribeShell();
      unsubscribeRequests();
      unsubscribeDelegated();
      unsubscribeConfig();
      unsubscribeAlerts?.();
      entry.gate.clear();
    };
    return entry;
  };

  const syncEnvironments = () => {
    const { notificationMode, inAppNotificationsEnabled } = getClientSettings();
    const enabled = notificationMode !== "off" || inAppNotificationsEnabled;
    if (!enabled) closeToasts(() => true);
    const environmentIds = enabled ? registry.get(environmentSummaries.environmentIdsAtom) : [];
    const activeIds = new Set(environmentIds);
    for (const [environmentId, entry] of watched) {
      if (activeIds.has(environmentId)) continue;
      entry.unsubscribe();
      watched.delete(environmentId);
    }
    for (const environmentId of environmentIds) {
      if (!watched.has(environmentId)) watched.set(environmentId, watchEnvironment(environmentId));
    }
  };

  const pruneRemovedEnvironments = () => {
    const activeIds = new Set(registry.get(environmentSummaries.environmentIdsAtom));
    closeToasts((key) => !activeIds.has(parseThreadKey(key).environmentId));
    const count = pending.size;
    for (const [tag, entry] of pending) {
      if (activeIds.has(entry.environmentId)) continue;
      entry.notification.close();
      pending.delete(tag);
    }
    if (count !== pending.size) setNotificationBadge(pending.size);
  };

  // Listeners that only exist for some notification modes, rebuilt when the mode changes.
  let appliedMode: ClientSettings["notificationMode"] | null = null;
  let stopModeListeners = () => {};
  const applyMode = () => {
    const nextMode = getClientSettings().notificationMode;
    if (nextMode === appliedMode) return;
    appliedMode = nextMode;
    stopModeListeners();
    clearPending();
    const stops: Array<() => void> = [];
    if (hasDesktopNotifications(nextMode)) {
      const unsubscribeBadgeClear = window.desktopBridge?.onNotificationBadgeClear(clearPending);
      window.addEventListener("focus", clearPending);
      stops.push(() => {
        unsubscribeBadgeClear?.();
        window.removeEventListener("focus", clearPending);
        clearPending();
      });
    }
    if (hasNotificationSound(nextMode)) {
      document.addEventListener("pointerdown", unlockNotificationAudio);
      document.addEventListener("keydown", unlockNotificationAudio);
      stops.push(() => {
        document.removeEventListener("pointerdown", unlockNotificationAudio);
        document.removeEventListener("keydown", unlockNotificationAudio);
      });
    }
    stopModeListeners = () => {
      for (const stop of stops) stop();
    };
  };

  const onSettings = () => {
    applyMode();
    syncEnvironments();
  };
  const unsubscribeSettings = subscribeClientSettings(onSettings);
  const unsubscribeEnvironmentIds = registry.subscribe(
    environmentSummaries.environmentIdsAtom,
    () => {
      pruneRemovedEnvironments();
      syncEnvironments();
    },
  );
  const unsubscribeHidden = [
    registry.subscribe(environmentThreadShells.hiddenThreadKeysAtom, closeHiddenPending),
    registry.subscribe(environmentThreadShells.anyEnvironmentHidingAtom, closeHiddenPending),
    registry.subscribe(environmentThreadShells.threadRefsAtom, closeHiddenPending),
  ];
  const unsubscribeRoute = router.subscribe("onResolved", closeOpenedThreadToasts);
  onSettings();

  return () => {
    unsubscribeSettings();
    unsubscribeEnvironmentIds();
    for (const unsubscribe of unsubscribeHidden) unsubscribe();
    unsubscribeRoute();
    for (const entry of watched.values()) entry.unsubscribe();
    watched.clear();
    stopModeListeners();
    closeToasts(() => true);
  };
}
