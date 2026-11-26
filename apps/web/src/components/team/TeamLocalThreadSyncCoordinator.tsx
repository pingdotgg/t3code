import { resolveProjectTeamAssignment } from "@t3tools/client-runtime/team";
import type {
  EnvironmentId,
  TeamSyncLocalThreadInput,
  TeamThreadNoteId,
  ThreadId,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { msg } from "gt-react";
import { StickyNoteIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { getClientSettings } from "~/hooks/useSettings";
import { m } from "~/i18n/messages";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import {
  clearPendingLocalThreadViewId,
  readPendingLocalThreadViewId,
  teamEnvironment,
  useTeamStatesByEnvironment,
} from "~/state/team";
import { environmentThreadStateAtom } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "~/threadNotifications";
import { toastManager } from "../ui/toast";

function buildLocalSyncPayload(input: {
  readonly localEnvironmentId: EnvironmentId;
  readonly localEnvironmentLabel: string;
  readonly teamProjectId: TeamSyncLocalThreadInput["projectId"];
  readonly defaultViewId: TeamSyncLocalThreadInput["viewId"];
  readonly shell: ReturnType<typeof useThreadShells>[number];
}): TeamSyncLocalThreadInput {
  const { localEnvironmentId, localEnvironmentLabel, teamProjectId, defaultViewId, shell } = input;
  const detailResult = appAtomRegistry.get(
    environmentThreadStateAtom(localEnvironmentId, shell.id),
  );
  const detailState = AsyncResult.value(detailResult);
  const detail =
    Option.isSome(detailState) && Option.isSome(detailState.value.data)
      ? detailState.value.data.value
      : null;

  const runs: TeamSyncLocalThreadInput["runs"] = detail
    ? detail.runs.map((run) => ({
        id: run.id as string,
        ordinal: run.ordinal,
        status: run.status === "preparing" ? "starting" : run.status,
        userMessageId: (run.userMessageId ?? `msg:${run.id}`) as string,
        createdAt: DateTime.formatIso(run.requestedAt),
        completedAt: run.completedAt ? DateTime.formatIso(run.completedAt) : null,
      }))
    : shell.latestRun
      ? [
          {
            id: shell.latestRun.runId as string,
            ordinal: 1,
            status: shell.latestRun.status === "preparing" ? "starting" : shell.latestRun.status,
            userMessageId: `msg:${shell.latestRun.runId}`,
            createdAt: shell.latestRun.startedAt ?? shell.createdAt,
            completedAt: shell.latestRun.completedAt ?? null,
          },
        ]
      : [];

  const messages: TeamSyncLocalThreadInput["messages"] = detail
    ? detail.messages
        .filter(
          (message): message is typeof message & { role: "user" | "assistant" | "system" } =>
            message.role === "user" || message.role === "assistant" || message.role === "system",
        )
        .map((message) => ({
          id: message.id,
          role: message.role,
          text: message.text,
          runId: message.runId,
          createdAt: DateTime.formatIso(message.createdAt),
          updatedAt: DateTime.formatIso(message.updatedAt),
        }))
    : [];

  return {
    threadId: shell.id,
    projectId: teamProjectId,
    ...(defaultViewId ? { viewId: defaultViewId } : {}),
    executionEnvironmentId: localEnvironmentId,
    executionEnvironmentLabel: localEnvironmentLabel,
    title: shell.title.trim() || m(msg("Untitled thread")),
    branch: shell.branch,
    modelSelection: shell.modelSelection,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    createdAt: shell.createdAt,
    updatedAt: shell.updatedAt,
    ...(shell.archivedAt !== null ? { archivedAt: shell.archivedAt } : { archivedAt: null }),
    ...(shell.deletedAt !== null ? { deletedAt: shell.deletedAt } : { deletedAt: null }),
    runs,
    messages,
  };
}

function isRunActive(status: string | null | undefined): boolean {
  return (
    status === "queued" ||
    status === "preparing" ||
    status === "starting" ||
    status === "running" ||
    status === "waiting"
  );
}

function buildShellFingerprint(input: {
  readonly shell: ReturnType<typeof useThreadShells>[number];
  readonly teamProjectId: TeamSyncLocalThreadInput["projectId"];
  readonly defaultViewId: TeamSyncLocalThreadInput["viewId"];
}): string {
  const { shell, teamProjectId, defaultViewId } = input;
  return [
    teamProjectId,
    defaultViewId ?? "",
    shell.title,
    shell.branch ?? "",
    shell.updatedAt,
    shell.archivedAt ?? "",
    shell.deletedAt ?? "",
    shell.latestRun?.runId ?? "",
    shell.latestRun?.status ?? "",
    shell.latestRun?.completedAt ?? "",
  ].join("\0");
}

interface SyncEntry {
  readonly syncKey: string;
  readonly shell: ReturnType<typeof useThreadShells>[number];
  readonly localEnvironmentId: EnvironmentId;
  readonly localEnvironmentLabel: string;
  readonly teamEnvironmentId: EnvironmentId;
  readonly teamProjectId: TeamSyncLocalThreadInput["projectId"];
  readonly defaultViewId: TeamSyncLocalThreadInput["viewId"];
  readonly shellFingerprint: string;
  readonly isActive: boolean;
}

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;

/**
 * Coordinates two Milestone 5 background flows at app root:
 * 1. Mirrors local-environment team-project threads (metadata, runs, transcript) to their correlated Team Server.
 * 2. Fires owner notifications when a colleague leaves a new pending thread note.
 */
export function TeamLocalThreadSyncCoordinator() {
  const router = useRouter();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const threadShells = useThreadShells();
  const teamStates = useTeamStatesByEnvironment();
  const syncLocalThread = useAtomCommand(teamEnvironment.syncLocalThread, { reportFailure: false });

  const syncedPayloadFingerprintByKeyRef = useRef(new Map<string, string>());
  const syncedShellFingerprintByKeyRef = useRef(new Map<string, string>());
  const syncInFlightRef = useRef(new Set<string>());
  const pendingRetryByKeyRef = useRef(new Map<string, SyncEntry>());
  const latestEntryByKeyRef = useRef(new Map<string, SyncEntry>());
  const retryAttemptsByKeyRef = useRef(new Map<string, number>());
  const retryTimerByKeyRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const subscriptionsByKeyRef = useRef(new Map<string, () => void>());

  const seenNoteIdsRef = useRef(new Set<TeamThreadNoteId>());
  const initializedTeamEnvsRef = useRef(new Set<EnvironmentId>());

  // Clean up all detail subscriptions and retry timers only on unmount so unrelated state changes
  // never trigger a full unsubscribe/resubscribe storm.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- disposes persistent background sync subscriptions and timers on unmount
  useEffect(() => {
    const subscriptions = subscriptionsByKeyRef.current;
    const retryTimers = retryTimerByKeyRef.current;
    return () => {
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
      for (const timer of retryTimers.values()) clearTimeout(timer);
      retryTimers.clear();
    };
  }, []);

  // 1. Local-to-Team thread mirroring for local threads whose project correlates to a Team Server.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes dirty or active local team-project thread snapshots to the remote Team Server without subscribing to idle historical threads
  useEffect(() => {
    if (!primaryEnvironmentId) return;
    const localEnv = environments.find((env) => env.environmentId === primaryEnvironmentId);
    const localLabel = localEnv?.label ?? "Local";
    const localProjectsById = new Map(
      projects
        .filter((project) => project.environmentId === primaryEnvironmentId)
        .map((project) => [project.id, project] as const),
    );
    const currentEntriesByKey = new Map<string, SyncEntry>();

    for (const shell of threadShells) {
      if (shell.environmentId !== primaryEnvironmentId) continue;
      const localProject = localProjectsById.get(shell.projectId);
      if (!localProject) continue;
      const assignment = resolveProjectTeamAssignment({ project: localProject, teamStates });
      if (!assignment || assignment.teamEnvironmentId === primaryEnvironmentId) continue;
      const syncKey = `${assignment.teamEnvironmentId}\0${shell.id}`;
      const existingAttribution = assignment.teamState.attributionByThreadId.get(shell.id);
      const isClosed = shell.deletedAt !== null || shell.archivedAt !== null;
      // Never start syncing threads that were already archived/deleted before ever being synced,
      // but DO propagate delete/archive transitions for threads already mirrored to the Team Server.
      if (
        isClosed &&
        existingAttribution === undefined &&
        !syncedShellFingerprintByKeyRef.current.has(syncKey)
      ) {
        continue;
      }
      const pendingViewId = readPendingLocalThreadViewId(shell.id);
      const defaultViewId =
        pendingViewId ??
        existingAttribution?.viewId ??
        assignment.assignment.defaultViewId ??
        undefined;
      const shellFingerprint = buildShellFingerprint({
        shell,
        teamProjectId: assignment.assignment.projectId,
        defaultViewId,
      });
      const entry: SyncEntry = {
        syncKey,
        shell,
        localEnvironmentId: primaryEnvironmentId,
        localEnvironmentLabel: localLabel,
        teamEnvironmentId: assignment.teamEnvironmentId,
        teamProjectId: assignment.assignment.projectId,
        defaultViewId,
        shellFingerprint,
        isActive: isRunActive(shell.latestRun?.status),
      };
      currentEntriesByKey.set(syncKey, entry);
      latestEntryByKeyRef.current.set(syncKey, entry);
    }

    // Drop subscriptions for threads that are no longer tracked.
    for (const [syncKey, unsubscribe] of subscriptionsByKeyRef.current) {
      if (!currentEntriesByKey.has(syncKey)) {
        unsubscribe();
        subscriptionsByKeyRef.current.delete(syncKey);
        latestEntryByKeyRef.current.delete(syncKey);
        const timer = retryTimerByKeyRef.current.get(syncKey);
        if (timer !== undefined) {
          clearTimeout(timer);
          retryTimerByKeyRef.current.delete(syncKey);
        }
      }
    }

    const releaseSubscriptionIfSettled = (syncKey: string) => {
      const latest = latestEntryByKeyRef.current.get(syncKey);
      if (!latest || latest.isActive) return;
      if (syncedShellFingerprintByKeyRef.current.get(syncKey) !== latest.shellFingerprint) return;
      const detailResult = appAtomRegistry.get(
        environmentThreadStateAtom(latest.localEnvironmentId, latest.shell.id),
      );
      const detailState = AsyncResult.value(detailResult);
      const hasLoadedDetail = Option.isSome(detailState) && Option.isSome(detailState.value.data);
      if (!hasLoadedDetail && latest.shell.deletedAt === null) return;
      const unsubscribe = subscriptionsByKeyRef.current.get(syncKey);
      if (unsubscribe) {
        unsubscribe();
        subscriptionsByKeyRef.current.delete(syncKey);
      }
    };

    const triggerSync = (syncKey: string) => {
      const entry = latestEntryByKeyRef.current.get(syncKey);
      if (!entry) return;
      const payload = buildLocalSyncPayload({
        localEnvironmentId: entry.localEnvironmentId,
        localEnvironmentLabel: entry.localEnvironmentLabel,
        teamProjectId: entry.teamProjectId,
        defaultViewId: entry.defaultViewId,
        shell: entry.shell,
      });
      const fingerprint = JSON.stringify(payload);
      if (syncedPayloadFingerprintByKeyRef.current.get(syncKey) === fingerprint) {
        syncedShellFingerprintByKeyRef.current.set(syncKey, entry.shellFingerprint);
        releaseSubscriptionIfSettled(syncKey);
        return;
      }
      if (syncInFlightRef.current.has(syncKey)) {
        pendingRetryByKeyRef.current.set(syncKey, entry);
        return;
      }
      const existingTimer = retryTimerByKeyRef.current.get(syncKey);
      if (existingTimer !== undefined) {
        clearTimeout(existingTimer);
        retryTimerByKeyRef.current.delete(syncKey);
      }
      syncInFlightRef.current.add(syncKey);
      pendingRetryByKeyRef.current.delete(syncKey);
      void syncLocalThread({
        environmentId: entry.teamEnvironmentId,
        input: payload,
      })
        .then((result) => {
          if (result._tag === "Success") {
            syncedPayloadFingerprintByKeyRef.current.set(syncKey, fingerprint);
            syncedShellFingerprintByKeyRef.current.set(syncKey, entry.shellFingerprint);
            retryAttemptsByKeyRef.current.delete(syncKey);
            clearPendingLocalThreadViewId(entry.shell.id);
            releaseSubscriptionIfSettled(syncKey);
          } else {
            const attempt = (retryAttemptsByKeyRef.current.get(syncKey) ?? 0) + 1;
            retryAttemptsByKeyRef.current.set(syncKey, attempt);
            const delayMs = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
            const timer = setTimeout(() => {
              retryTimerByKeyRef.current.delete(syncKey);
              triggerSync(syncKey);
            }, delayMs);
            retryTimerByKeyRef.current.set(syncKey, timer);
          }
        })
        .finally(() => {
          syncInFlightRef.current.delete(syncKey);
          const pending = pendingRetryByKeyRef.current.get(syncKey);
          if (pending) {
            pendingRetryByKeyRef.current.delete(syncKey);
            triggerSync(pending.syncKey);
          }
        });
    };

    for (const [syncKey, entry] of currentEntriesByKey) {
      const isDirty =
        syncedShellFingerprintByKeyRef.current.get(syncKey) !== entry.shellFingerprint;
      if (!isDirty && !entry.isActive) {
        releaseSubscriptionIfSettled(syncKey);
        continue;
      }
      if (!subscriptionsByKeyRef.current.has(syncKey)) {
        const atom = environmentThreadStateAtom(entry.localEnvironmentId, entry.shell.id);
        const unsubscribe = appAtomRegistry.subscribe(atom, () => {
          triggerSync(syncKey);
        });
        subscriptionsByKeyRef.current.set(syncKey, unsubscribe);
      }
      triggerSync(syncKey);
    }
  }, [environments, primaryEnvironmentId, projects, syncLocalThread, teamStates, threadShells]);

  // 2. Owner notifications when a colleague leaves a new pending note on a thread owned by currentMember.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fires in-app/desktop notifications when newly arriving team thread notes target the current member's threads
  useEffect(() => {
    for (const [teamEnvId, state] of teamStates) {
      if (state.team === null || state.currentMember === null) continue;
      const isInitialLoad = !initializedTeamEnvsRef.current.has(teamEnvId);
      const currentMemberId = state.currentMember.id;

      for (const [threadId, notes] of state.threadNotesByThreadId) {
        const attribution = state.attributionByThreadId.get(threadId);
        for (const note of notes) {
          if (seenNoteIdsRef.current.has(note.id)) continue;
          seenNoteIdsRef.current.add(note.id);
          if (isInitialLoad) continue;
          if (note.status !== "pending") continue;
          if (note.authorMemberId === currentMemberId) continue;
          // Fail closed if thread attribution has not loaded yet so non-owners never receive spurious alerts.
          if (!attribution || attribution.creatorMemberId !== currentMemberId) continue;

          const targetEnvId: EnvironmentId =
            attribution?.isLocalSynced && attribution.executionEnvironmentId
              ? attribution.executionEnvironmentId
              : teamEnvId;
          const title = m(msg("New note from {author}", { author: note.authorPseudo }));
          const bodyPreview =
            note.originalBody.length > 140
              ? `${note.originalBody.slice(0, 137)}…`
              : note.originalBody;
          const { notificationMode: mode, inAppNotificationsEnabled } = getClientSettings();
          if (hasNotificationSound(mode)) {
            void playNotificationSound("input", () =>
              hasNotificationSound(getClientSettings().notificationMode),
            );
          }
          if (inAppNotificationsEnabled) {
            const toastId = toastManager.add({
              type: "info",
              title,
              description: bodyPreview,
              data: {
                hideCopyButton: true,
                leadingIcon: <StickyNoteIcon aria-hidden className="size-4 text-info-foreground" />,
              },
              actionProps: {
                children: m(msg("Open thread")),
                onClick: () => {
                  toastManager.close(toastId);
                  void router.navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId: targetEnvId, threadId: threadId as ThreadId },
                  });
                },
              },
            });
          }
          if (
            hasDesktopNotifications(mode) &&
            !(document.visibilityState === "visible" && document.hasFocus()) &&
            typeof Notification !== "undefined" &&
            Notification.permission === "granted"
          ) {
            const desktopNotification = new Notification(title, {
              body: bodyPreview,
              tag: `team-note:${note.id}`,
            });
            desktopNotification.onclick = () => {
              window.focus();
              void router.navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId: targetEnvId, threadId: threadId as ThreadId },
              });
            };
          }
        }
      }
      initializedTeamEnvsRef.current.add(teamEnvId);
    }
  }, [router, teamStates]);

  return null;
}
