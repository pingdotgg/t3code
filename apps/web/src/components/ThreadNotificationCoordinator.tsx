import { msg } from "gt-react";
import { m } from "../i18n/messages";
import {
  resolveTeamNotificationSoundPreset,
  resolveThreadTeamId,
  type TeamEnvironmentState,
} from "@t3tools/client-runtime/team";
import {
  type EnvironmentThreadShell,
  type PendingSubagentRequest,
  presentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import type { AnyRouter } from "@tanstack/react-router";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  TeamId,
  TeamQueuedMessageNotification,
  ThreadId,
} from "@t3tools/contracts";
import { monitorHoldsWakeCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import type { ClientSettings } from "@t3tools/contracts/settings";
import * as Option from "effect/Option";
import type { AtomRegistry } from "effect/reactivity";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  ListPlusIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";

import { getClientSettings, subscribeClientSettings } from "../hooks/useSettings";
import { isWindowsPlatform } from "../lib/utils";
import { environmentSummaries } from "../state/presentation";
import { environmentShell } from "../state/shell";
import { readTeamEnvironmentStateFromRegistry, teamEnvironment } from "../state/team";
import { environmentThreadShells } from "../state/threads";
import {
  formatTeamNotificationThreadTitle,
  formatTeamQueuedMessageNotification,
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  resolveTeamEnvironmentThreadNotificationDecision,
  setNotificationBadge,
  teamQueuedMessageNotificationTag,
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
import { readTeamThreadLocation } from "../state/team";
import {
  isTeamSnoozeActive,
  isTeamThreadSnoozedForNotification,
  overlayTeamThreadSnooze,
} from "./team/threadSnooze";
import { teamNotificationSnoozeAction } from "./team/notificationSnooze";
import { toastManager } from "./ui/toast";

interface NotificationState extends ThreadNotificationObservation {
  readonly raw: OrchestrationV2ThreadShell;
  readonly subagentRequest: PendingSubagentRequest | null;
  readonly thread: EnvironmentThreadShell;
  readonly status: SidebarThreadStatus;
}

type ToastId = ReturnType<typeof toastManager.add>;

type DeferredNotificationReason = "team_loading" | "thread_attribution" | "turn_attribution";

interface WatchedEnvironment {
  unsubscribe: () => void;
  previous: Map<ThreadId, NotificationState>;
  deferred: Map<
    ThreadId,
    {
      readonly state: NotificationState;
      readonly kind: ThreadNotificationKind;
      reason: DeferredNotificationReason;
    }
  >;
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
    {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      notification: Notification;
      isQueuedMessage?: boolean;
    }
  >();
  const watched = new Map<EnvironmentId, WatchedEnvironment>();

  const trackNotification = (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    notification: Notification,
    options?: { readonly isQueuedMessage?: boolean },
  ) => {
    pending.get(notification.tag)?.notification.close();
    pending.set(notification.tag, {
      environmentId,
      threadId,
      notification,
      ...(options?.isQueuedMessage === true ? { isQueuedMessage: true } : {}),
    });
    setNotificationBadge(pending.size);
  };
  // Toast ids by thread key, so hiding or opening a thread, or removing its environment, closes them.
  const openToasts = new Map<
    string,
    Array<{ readonly id: ToastId; readonly isQueuedMessage?: boolean }>
  >();
  const forgetToast = (key: string, toastId: ToastId) => {
    const remaining = (openToasts.get(key) ?? []).filter((entry) => entry.id !== toastId);
    if (remaining.length === 0) openToasts.delete(key);
    else openToasts.set(key, remaining);
  };
  const closeToasts = (
    shouldClose: (
      key: string,
      entry: { readonly id: ToastId; readonly isQueuedMessage?: boolean },
    ) => boolean,
  ) => {
    for (const [key, toastEntries] of openToasts) {
      const remaining: Array<{ readonly id: ToastId; readonly isQueuedMessage?: boolean }> = [];
      for (const toastEntry of toastEntries) {
        if (shouldClose(key, toastEntry)) {
          toastManager.close(toastEntry.id);
        } else {
          remaining.push(toastEntry);
        }
      }
      if (remaining.length === 0) openToasts.delete(key);
      else openToasts.set(key, remaining);
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

  const playTeamAwareNotificationSound = (
    kind: ThreadNotificationKind,
    mode: ClientSettings["notificationMode"],
    teamId: TeamId | null,
    teamNotificationSounds: ClientSettings["teamNotificationSounds"],
  ) => {
    const teamSoundPreset =
      teamId === null
        ? null
        : resolveTeamNotificationSoundPreset({
            teamId,
            teamNotificationSounds,
          });
    if (!hasNotificationSound(mode) || teamSoundPreset === "off") return;
    const shouldPlay = () => {
      const latest = getClientSettings();
      if (!hasNotificationSound(latest.notificationMode)) return false;
      if (teamId === null) return true;
      return (
        resolveTeamNotificationSoundPreset({
          teamId,
          teamNotificationSounds: latest.teamNotificationSounds,
        }) !== "off"
      );
    };
    void (teamSoundPreset === null
      ? playNotificationSound(kind, shouldPlay)
      : playNotificationSound(kind, shouldPlay, teamSoundPreset));
  };

  const present = (
    environmentId: EnvironmentId,
    state: NotificationState,
    kind: ThreadNotificationKind,
  ) => {
    const { thread, status } = state;
    const watchedEntry = watched.get(environmentId);
    if (
      registry
        .get(environmentThreadShells.hiddenThreadKeysAtom)
        .has(threadKey({ environmentId, threadId: thread.id }))
    ) {
      watchedEntry?.deferred.delete(thread.id);
      return;
    }
    const teamState =
      readTeamThreadLocation(environmentId, thread.id, registry)?.teamState ??
      readTeamEnvironmentStateFromRegistry(registry, environmentId);
    const now = Date.now();
    if (
      teamState?.attributionByThreadId.has(thread.id) &&
      (isTeamThreadSnoozedForNotification(teamState, thread.id, now) ||
        isSnoozedForNotification(
          overlayTeamThreadSnooze(thread, teamState),
          state.completedAt,
          now,
        ))
    )
      return;
    const decision = resolveTeamEnvironmentThreadNotificationDecision({
      teamState,
      threadId: thread.id,
      latestRunId: thread.latestRun?.runId ?? null,
      threadCreatedAt: thread.createdAt,
    });
    if (decision === "defer") {
      const reason: DeferredNotificationReason =
        teamState === null
          ? "team_loading"
          : !teamState.attributionByThreadId.has(thread.id)
            ? "thread_attribution"
            : "turn_attribution";
      watchedEntry?.deferred.set(thread.id, { state, kind, reason });
      return;
    }
    watchedEntry?.deferred.delete(thread.id);
    if (decision === "suppress") return;
    const notificationThreadTitle = formatTeamNotificationThreadTitle({
      title: thread.title,
      teamState,
      threadId: thread.id,
    });
    const resolveNotificationTeamId = (): TeamId | null => {
      if (teamState?.team != null) {
        return teamState.attributionByThreadId.get(thread.id)?.teamId ?? teamState.team.id;
      }
      const teamStates = new Map<EnvironmentId, TeamEnvironmentState>();
      for (const envId of registry.get(environmentSummaries.environmentIdsAtom)) {
        const envTeamState = readTeamEnvironmentStateFromRegistry(registry, envId);
        if (envTeamState?.team != null) teamStates.set(envId, envTeamState);
      }
      if (teamStates.size === 0) return null;
      const shellState = registry.get(environmentShell.stateValueAtom(environmentId));
      const projects =
        shellState !== null && Option.isSome(shellState.snapshot)
          ? (shellState.snapshot.value.projects ?? [])
          : [];
      const projectShell = projects.find((candidate) => candidate.id === state.raw.projectId);
      return resolveThreadTeamId({
        environmentId,
        threadId: thread.id,
        project: projectShell
          ? {
              id: projectShell.id,
              environmentId,
              repositoryIdentity: projectShell.repositoryIdentity,
            }
          : { id: state.raw.projectId, environmentId },
        teamStates,
      });
    };
    const settings = getClientSettings();
    const { notificationMode: mode, inAppNotificationsEnabled } = settings;
    const teamId = resolveNotificationTeamId();
    const active = activeThread();
    const title =
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
                : m(msg("Input needed"));
    playTeamAwareNotificationSound(kind, mode, teamId, settings.teamNotificationSounds);
    if (
      inAppNotificationsEnabled &&
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      (active.environmentId !== environmentId || active.threadId !== thread.id)
    ) {
      const toastKey = threadKey({ environmentId, threadId: thread.id });
      const toastId: ToastId = toastManager.add({
        onRemove: (): void => forgetToast(toastKey, toastId),
        type: kind === "completion" ? "success" : status === "failed" ? "error" : "warning",
        title,
        description: notificationThreadTitle,
        data: {
          ...teamNotificationSnoozeAction(
            registry,
            environmentId,
            thread.id,
            settings.timestampFormat,
            () => toastManager.close(toastId),
          ),
          hideCopyButton: true,
          leadingIcon:
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
        },
        actionProps: {
          children: m(msg("Open thread")),
          onClick: () => {
            toastManager.close(toastId);
            void router.navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId: thread.id },
            });
          },
        },
      });
      openToasts.set(toastKey, [...(openToasts.get(toastKey) ?? []), { id: toastId }]);
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
      const notification = new Notification(title, {
        body: notificationThreadTitle,
        tag: threadNotificationTag(environmentId, thread.id),
        silent: true,
        // Windows drops clicks after a toast moves into Notification Center.
        requireInteraction: kind === "completion" && isWindowsPlatform(navigator.platform),
      });
      trackNotification(environmentId, thread.id, notification);
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        void window.desktopBridge?.revealWindow().catch(() => undefined);
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: thread.id },
        });
      });
    } catch {
      // Some browsers expose Notification but reject desktop presentation.
    }
  };

  const presentQueuedMessage = (
    environmentId: EnvironmentId,
    teamId: TeamId,
    item: TeamQueuedMessageNotification,
    rawThreadTitle: string | null,
  ) => {
    if (
      registry
        .get(environmentThreadShells.hiddenThreadKeysAtom)
        .has(threadKey({ environmentId, threadId: item.threadId }))
    ) {
      return;
    }
    const { title, body } = formatTeamQueuedMessageNotification({
      senderPseudo: item.senderPseudo,
      threadTitle: rawThreadTitle,
      messagePreview: item.messagePreview,
    });
    const settings = getClientSettings();
    const { notificationMode: mode, inAppNotificationsEnabled } = settings;
    const active = activeThread();
    playTeamAwareNotificationSound("input", mode, teamId, settings.teamNotificationSounds);
    if (
      inAppNotificationsEnabled &&
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      (active.environmentId !== environmentId || active.threadId !== item.threadId)
    ) {
      const toastKey = threadKey({ environmentId, threadId: item.threadId });
      const toastId: ToastId = toastManager.add({
        onRemove: (): void => forgetToast(toastKey, toastId),
        type: "info",
        title,
        description: body,
        data: {
          ...teamNotificationSnoozeAction(
            registry,
            environmentId,
            item.threadId,
            settings.timestampFormat,
            () => toastManager.close(toastId),
          ),
          hideCopyButton: true,
          leadingIcon: <ListPlusIcon aria-hidden className="size-4 text-info-foreground" />,
        },
        actionProps: {
          children: m(msg("Open thread")),
          onClick: () => {
            toastManager.close(toastId);
            void router.navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId: item.threadId },
            });
          },
        },
      });
      openToasts.set(toastKey, [
        ...(openToasts.get(toastKey) ?? []),
        { id: toastId, isQueuedMessage: true },
      ]);
      return;
    }
    if (
      !hasDesktopNotifications(mode) ||
      (document.visibilityState === "visible" && document.hasFocus()) ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    ) {
      return;
    }
    try {
      const notification = new Notification(title, {
        body,
        tag: teamQueuedMessageNotificationTag(environmentId, item.threadId, item.queuedRunId),
        silent: true,
      });
      trackNotification(environmentId, item.threadId, notification, { isQueuedMessage: true });
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        void window.desktopBridge?.revealWindow().catch(() => undefined);
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: item.threadId },
        });
      });
    } catch {
      // Some browsers expose Notification but reject desktop presentation.
    }
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
    const now = Date.now();
    for (const [threadId, pendingDeferred] of entry.deferred) {
      const current = next.get(threadId);
      if (
        current === undefined ||
        current.thread.archivedAt !== null ||
        current.raw.latestRunStopRequested === true ||
        current.thread.latestRun?.runId !== pendingDeferred.state.thread.latestRun?.runId ||
        (pendingDeferred.kind === "input" &&
          current.attention !== pendingDeferred.state.attention) ||
        (pendingDeferred.kind === "completion" && !current.settled) ||
        isSnoozedForNotification(current.thread, current.completedAt, now)
      ) {
        entry.deferred.delete(threadId);
      }
    }
    entry.gate.retain(new Set(next.keys()));
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
      deferred: new Map(),
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
        entry.deferred.clear();
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
    const MAX_SEEN_QUEUED_RUN_IDS = 1_000;
    const seenQueuedRunIds = new Set<string>();
    const rememberSeenQueuedRunId = (queuedRunId: string) => {
      seenQueuedRunIds.delete(queuedRunId);
      seenQueuedRunIds.add(queuedRunId);
      while (seenQueuedRunIds.size > MAX_SEEN_QUEUED_RUN_IDS) {
        const oldest = seenQueuedRunIds.values().next().value;
        if (oldest === undefined) break;
        seenQueuedRunIds.delete(oldest);
      }
    };
    const initialTeamState = readTeamEnvironmentStateFromRegistry(registry, environmentId);
    if (initialTeamState !== null) {
      for (const item of initialTeamState.queuedMessageNotifications) {
        rememberSeenQueuedRunId(item.queuedRunId);
      }
    }
    const unsubscribeTeam = registry.subscribe(teamEnvironment.state(environmentId), () => {
      const teamState = readTeamEnvironmentStateFromRegistry(registry, environmentId);
      if (teamState === null) return;
      if (
        teamState.team !== null &&
        teamState.currentMember !== null &&
        teamState.currentMember.status === "active"
      ) {
        const currentMemberId = teamState.currentMember.id;
        for (const item of teamState.queuedMessageNotifications) {
          if (seenQueuedRunIds.has(item.queuedRunId)) continue;
          rememberSeenQueuedRunId(item.queuedRunId);
          if (item.senderMemberId === currentMemberId) continue;
          if (
            !item.recipientMemberIds.includes(currentMemberId) ||
            isTeamSnoozeActive(teamState, item.threadId, Date.now())
          )
            continue;
          const rawThreadTitle =
            entry.previous.get(item.threadId)?.thread.title ??
            threads?.find((candidate) => candidate.id === item.threadId)?.title ??
            null;
          presentQueuedMessage(environmentId, teamState.team.id, item, rawThreadTitle);
        }
      }
      for (const [threadId, deferred] of entry.deferred) {
        const latestRunId = deferred.state.thread.latestRun?.runId ?? null;
        if (deferred.reason === "turn_attribution") {
          const matchedTurn =
            latestRunId !== null
              ? (teamState.turnAuthorByTurnId.get(latestRunId) ??
                (teamState.latestTurnByThreadId.get(threadId)?.turnId === latestRunId
                  ? teamState.latestTurnByThreadId.get(threadId)
                  : undefined))
              : undefined;
          if (matchedTurn === undefined) {
            if (teamState.followedThreadIds.has(threadId)) {
              entry.deferred.delete(threadId);
            }
            continue;
          }
        }
        const decision = resolveTeamEnvironmentThreadNotificationDecision({
          teamState,
          threadId,
          latestRunId,
          threadCreatedAt: deferred.state.thread.createdAt,
        });
        if (decision === "allow") {
          entry.deferred.delete(threadId);
          const current = entry.previous.get(threadId);
          const now = Date.now();
          if (
            current !== undefined &&
            current.thread.archivedAt === null &&
            current.raw.latestRunStopRequested !== true &&
            (current.thread.latestRun?.runId ?? null) === latestRunId &&
            (deferred.kind === "input"
              ? current.attention === deferred.state.attention
              : current.settled) &&
            !isSnoozedForNotification(current.thread, current.completedAt, now)
          ) {
            present(environmentId, current, deferred.kind);
          }
        } else if (decision === "suppress") {
          entry.deferred.delete(threadId);
        } else {
          deferred.reason = !teamState.attributionByThreadId.has(threadId)
            ? "thread_attribution"
            : "turn_attribution";
        }
      }
      const isSilenced = (threadId: ThreadId) => {
        const previousState = entry.previous.get(threadId);
        return (
          resolveTeamEnvironmentThreadNotificationDecision({
            teamState,
            threadId,
            latestRunId: previousState?.thread.latestRun?.runId ?? null,
            threadCreatedAt: previousState?.thread.createdAt ?? null,
          }) !== "allow"
        );
      };
      const isRevokedTeamThread = (threadId: ThreadId) =>
        teamState.team !== null &&
        (teamState.currentMember === null ||
          teamState.currentMember.status !== "active" ||
          !teamState.attributionByThreadId.has(threadId));
      closeToasts((key, toastEntry) => {
        const parsed = parseThreadKey(key);
        if (parsed.environmentId !== environmentId) return false;
        return toastEntry.isQueuedMessage === true
          ? isRevokedTeamThread(parsed.threadId)
          : isSilenced(parsed.threadId);
      });
      const count = pending.size;
      for (const [tag, item] of pending) {
        if (item.environmentId !== environmentId) continue;
        const shouldCloseItem =
          item.isQueuedMessage === true
            ? isRevokedTeamThread(item.threadId)
            : isSilenced(item.threadId);
        if (shouldCloseItem) {
          item.notification.close();
          pending.delete(tag);
        }
      }
      if (count !== pending.size) setNotificationBadge(pending.size);
    });
    entry.unsubscribe = () => {
      unsubscribeShell();
      unsubscribeRequests();
      unsubscribeDelegated();
      unsubscribeTeam();
      entry.deferred.clear();
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
      // Electron's default autoplay policy needs no gesture, unlike browsers.
      if (window.desktopBridge) unlockNotificationAudio();
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
