import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  resolveProjectTeamAssignment,
  resolveTeamNotificationSoundPreset,
} from "@t3tools/client-runtime/team";
import {
  NonNegativeInt,
  type EnvironmentId,
  type TeamId,
  type TeamSyncLocalThreadInput,
  type TeamThreadNoteId,
  type ThreadId,
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
import { readLocalThreadAccess, teamEnvironment, useTeamStatesByEnvironment } from "~/state/team";
import { environmentThreadStateAtom } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "~/threadNotifications";
import { toastManager } from "../ui/toast";

export const STREAMING_SYNC_THROTTLE_MS = 750;

export interface StreamingSyncThrottleController {
  readonly schedule: (
    key: string,
    options: { readonly isActive: boolean; readonly immediate?: boolean },
  ) => void;
  readonly flushAllPending: () => void;
  readonly clear: (key: string) => void;
  readonly dispose: () => void;
}

export function createStreamingSyncThrottleController(input: {
  readonly throttleMs?: number;
  readonly onFlush: (key: string) => void;
  readonly now?: () => number;
}): StreamingSyncThrottleController {
  const throttleMs = input.throttleMs ?? STREAMING_SYNC_THROTTLE_MS;
  const now = input.now ?? Date.now;
  const timerByKey = new Map<string, ReturnType<typeof setTimeout>>();
  const lastSentAtByKey = new Map<string, number>();
  const wasActiveByKey = new Map<string, boolean>();

  const cancelTimer = (key: string) => {
    const existing = timerByKey.get(key);
    if (existing !== undefined) {
      clearTimeout(existing);
      timerByKey.delete(key);
    }
  };

  const flushNow = (key: string) => {
    cancelTimer(key);
    lastSentAtByKey.set(key, now());
    input.onFlush(key);
  };

  return {
    schedule(key, options) {
      const prevActive = wasActiveByKey.get(key) === true;
      wasActiveByKey.set(key, options.isActive);
      // Flush immediately on turn start (inactive -> active), terminal/idle states, or explicit immediate flushes.
      if (!options.isActive || options.immediate || !prevActive) {
        flushNow(key);
        return;
      }
      if (timerByKey.has(key)) {
        return;
      }
      const lastSentAt = lastSentAtByKey.get(key);
      const elapsed = lastSentAt === undefined ? throttleMs : now() - lastSentAt;
      if (elapsed >= throttleMs) {
        flushNow(key);
        return;
      }
      const delayMs = Math.max(0, throttleMs - elapsed);
      const timer = setTimeout(() => {
        timerByKey.delete(key);
        lastSentAtByKey.set(key, now());
        input.onFlush(key);
      }, delayMs);
      timerByKey.set(key, timer);
    },
    flushAllPending() {
      for (const [key, timer] of Array.from(timerByKey.entries())) {
        clearTimeout(timer);
        timerByKey.delete(key);
        lastSentAtByKey.set(key, now());
        input.onFlush(key);
      }
    },
    clear(key) {
      cancelTimer(key);
      lastSentAtByKey.delete(key);
      wasActiveByKey.delete(key);
    },
    dispose() {
      this.flushAllPending();
      lastSentAtByKey.clear();
      wasActiveByKey.clear();
    },
  };
}

function buildLocalSyncPayload(input: {
  readonly localEnvironmentId: EnvironmentId;
  readonly localEnvironmentLabel: string;
  readonly teamProjectId: TeamSyncLocalThreadInput["projectId"];
  readonly defaultViewId: TeamSyncLocalThreadInput["viewId"];
  readonly initialLocked?: boolean;
  readonly shell: ReturnType<typeof useThreadShells>[number];
}): TeamSyncLocalThreadInput {
  const {
    localEnvironmentId,
    localEnvironmentLabel,
    teamProjectId,
    defaultViewId,
    initialLocked,
    shell,
  } = input;
  const detailResult = appAtomRegistry.get(
    environmentThreadStateAtom(localEnvironmentId, shell.id),
  );
  const detailState = AsyncResult.value(detailResult);
  const detail =
    Option.isSome(detailState) && Option.isSome(detailState.value.data)
      ? detailState.value.data.value
      : null;

  // Defer run mirroring until authoritative thread detail loads so we never fabricate ordinal: 1
  // for a multi-run thread's latest run (which would collide with real run #1 on SQLite's
  // unique (thread_id, ordinal) index).
  const runs: TeamSyncLocalThreadInput["runs"] = detail
    ? detail.runs.map((run) => ({
        id: run.id as string,
        ordinal: run.ordinal,
        status: run.status === "preparing" ? "starting" : run.status,
        userMessageId: (run.userMessageId ?? `msg:${run.id}`) as string,
        createdAt: DateTime.formatIso(run.requestedAt),
        completedAt: run.completedAt ? DateTime.formatIso(run.completedAt) : null,
      }))
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
    ...(initialLocked ? { locked: true } : {}),
    executionEnvironmentId: localEnvironmentId,
    executionEnvironmentLabel: localEnvironmentLabel,
    title: shell.title.trim() || m(msg("Untitled thread")),
    branch: shell.branch,
    modelSelection: shell.modelSelection,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    createdAt: shell.createdAt,
    updatedAt: shell.updatedAt,
    ...(Option.isSome(detailState) && detailState.value.sequence > 0
      ? { syncSeq: NonNegativeInt.make(detailState.value.sequence) }
      : {}),
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
  readonly initialLocked?: boolean;
}): string {
  const { shell, teamProjectId, defaultViewId, initialLocked } = input;
  return [
    teamProjectId,
    defaultViewId ?? "",
    initialLocked ? "1" : "0",
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
  readonly initialLocked: boolean;
  readonly shellFingerprint: string;
  readonly isActive: boolean;
}

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;
const MAX_SYNC_RETRIES = 6;
const PERMANENT_SYNC_ERROR_CODES = new Set(["forbidden", "invalid_input", "not_found"]);

function isPermanentSyncError(failure: unknown): boolean {
  if (typeof failure !== "object" || failure === null) return false;
  const code = "code" in failure ? (failure as { readonly code?: unknown }).code : undefined;
  return typeof code === "string" && PERMANENT_SYNC_ERROR_CODES.has(code);
}

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
  const issueLocalSyncToken = useAtomCommand(teamEnvironment.issueLocalSyncToken, {
    reportFailure: false,
  });
  const syncLocalBinding = useAtomCommand(teamEnvironment.syncLocalBinding, {
    reportFailure: false,
  });
  const removeLocalBinding = useAtomCommand(teamEnvironment.removeLocalBinding, {
    reportFailure: false,
  });
  const notifyLocalAssetsUpdated = useAtomCommand(teamEnvironment.notifyLocalAssetsUpdated, {
    reportFailure: false,
  });

  const localSyncTokenByTeamEnvRef = useRef(new Map<EnvironmentId, string>());
  const syncedBindingFingerprintByTeamIdRef = useRef(new Map<TeamId, string>());
  const syncedAssetsRevisionByTeamIdRef = useRef(new Map<TeamId, number>());
  const boundTeamIdsRef = useRef(new Set<TeamId>());
  const envIdByBoundTeamIdRef = useRef(new Map<TeamId, EnvironmentId>());
  const connectedActiveMemberByEnvIdRef = useRef(new Map<EnvironmentId, string>());

  const syncedPayloadFingerprintByKeyRef = useRef(new Map<string, string>());
  const syncedShellFingerprintByKeyRef = useRef(new Map<string, string>());
  const syncInFlightFingerprintByKeyRef = useRef(new Map<string, string>());
  const pendingRetryByKeyRef = useRef(new Map<string, SyncEntry>());
  const latestEntryByKeyRef = useRef(new Map<string, SyncEntry>());
  const pendingClosingEntriesByKeyRef = useRef(new Map<string, SyncEntry>());
  const retryAttemptsByKeyRef = useRef(new Map<string, number>());
  const retryScheduledFingerprintByKeyRef = useRef(new Map<string, string>());
  const retryTimerByKeyRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const liveTeamEnvIdsRef = useRef(new Set<EnvironmentId>());
  const subscriptionsByKeyRef = useRef(new Map<string, () => void>());
  const executeSyncRef = useRef<(syncKey: string, options?: { readonly force?: boolean }) => void>(
    () => {},
  );
  const streamingThrottleRef = useRef<StreamingSyncThrottleController | null>(null);

  const seenNoteIdsRef = useRef(new Set<TeamThreadNoteId>());
  const initializedTeamEnvsRef = useRef(new Set<EnvironmentId>());

  // Clean up all detail subscriptions and timers only on unmount (flushing any pending throttled
  // streaming snapshots first so final state is never lost), and flush on visibility-hide / pagehide.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- disposes persistent background sync subscriptions and timers on unmount
  useEffect(() => {
    const subscriptions = subscriptionsByKeyRef.current;
    const retryTimers = retryTimerByKeyRef.current;
    const throttle = createStreamingSyncThrottleController({
      throttleMs: STREAMING_SYNC_THROTTLE_MS,
      onFlush: (syncKey) => {
        executeSyncRef.current(syncKey);
      },
    });
    streamingThrottleRef.current = throttle;
    const handleVisibilityChange = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        throttle.flushAllPending();
      }
    };
    const handlePageHide = () => {
      throttle.flushAllPending();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", handlePageHide);
    }
    return () => {
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("pagehide", handlePageHide);
      }
      throttle.dispose();
      streamingThrottleRef.current = null;
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
      const savedAccess = readLocalThreadAccess(shell.environmentId, shell.id);
      const targetId = savedAccess?.teamEnvironmentId;
      const targetState = targetId ? teamStates.get(targetId) : undefined;
      if (targetId && !targetState) continue;
      const assignment = resolveProjectTeamAssignment({
        project: localProject,
        teamStates: targetId && targetState ? new Map([[targetId, targetState]]) : teamStates,
      });
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
      const defaultViewId =
        existingAttribution?.viewId ??
        savedAccess?.viewId ??
        assignment.assignment.defaultViewId ??
        undefined;
      const initialLocked = existingAttribution === undefined && savedAccess?.locked === true;
      const shellFingerprint = buildShellFingerprint({
        shell,
        teamProjectId: assignment.assignment.projectId,
        defaultViewId,
        initialLocked,
      });
      const entry: SyncEntry = {
        syncKey,
        shell,
        localEnvironmentId: primaryEnvironmentId,
        localEnvironmentLabel: localLabel,
        teamEnvironmentId: assignment.teamEnvironmentId,
        teamProjectId: assignment.assignment.projectId,
        defaultViewId,
        initialLocked,
        shellFingerprint,
        isActive: isRunActive(shell.latestRun?.status),
      };
      currentEntriesByKey.set(syncKey, entry);
      latestEntryByKeyRef.current.set(syncKey, entry);
    }

    const currentLiveTeamEnvIds = new Set<EnvironmentId>();
    const newlyLiveTeamEnvIds = new Set<EnvironmentId>();
    for (const [envId, state] of teamStates) {
      if (state.team != null) {
        currentLiveTeamEnvIds.add(envId);
        if (!liveTeamEnvIdsRef.current.has(envId)) {
          newlyLiveTeamEnvIds.add(envId);
        }
      }
    }
    liveTeamEnvIdsRef.current = currentLiveTeamEnvIds;

    // Reset retry exhaustion/backoff for any sync entries whose Team Server just reconnected.
    if (newlyLiveTeamEnvIds.size > 0) {
      for (const [syncKey, entry] of latestEntryByKeyRef.current) {
        if (!newlyLiveTeamEnvIds.has(entry.teamEnvironmentId)) continue;
        retryAttemptsByKeyRef.current.delete(syncKey);
        retryScheduledFingerprintByKeyRef.current.delete(syncKey);
        const timer = retryTimerByKeyRef.current.get(syncKey);
        if (timer !== undefined) {
          clearTimeout(timer);
          retryTimerByKeyRef.current.delete(syncKey);
        }
      }
    }

    // Propagate archive/delete transitions when a previously-synced thread disappears from active
    // `threadShells` while its local project is STILL assigned to the same live Team Server
    // (avoiding false archives when a project is unassigned or Team Server state transiently drops).
    for (const [syncKey, previousEntry] of Array.from(latestEntryByKeyRef.current.entries())) {
      if (currentEntriesByKey.has(syncKey)) {
        if (pendingClosingEntriesByKeyRef.current.delete(syncKey)) {
          retryAttemptsByKeyRef.current.delete(syncKey);
          retryScheduledFingerprintByKeyRef.current.delete(syncKey);
          const timer = retryTimerByKeyRef.current.get(syncKey);
          if (timer !== undefined) {
            clearTimeout(timer);
            retryTimerByKeyRef.current.delete(syncKey);
          }
        }
        continue;
      }
      const unsubscribe = subscriptionsByKeyRef.current.get(syncKey);
      if (unsubscribe) {
        unsubscribe();
        subscriptionsByKeyRef.current.delete(syncKey);
      }
      const localProject = localProjectsById.get(previousEntry.shell.projectId);
      const stillAssignedToSameTeam =
        localProject !== undefined &&
        resolveProjectTeamAssignment({ project: localProject, teamStates })?.teamEnvironmentId ===
          previousEntry.teamEnvironmentId;
      const teamStateLive = currentLiveTeamEnvIds.has(previousEntry.teamEnvironmentId);
      const wasSynced = syncedShellFingerprintByKeyRef.current.has(syncKey);
      if (
        stillAssignedToSameTeam &&
        teamStateLive &&
        wasSynced &&
        !pendingClosingEntriesByKeyRef.current.has(syncKey)
      ) {
        const detailResult = appAtomRegistry.get(
          environmentThreadStateAtom(previousEntry.localEnvironmentId, previousEntry.shell.id),
        );
        const detailState = AsyncResult.value(detailResult);
        const detail =
          Option.isSome(detailState) && Option.isSome(detailState.value.data)
            ? detailState.value.data.value
            : null;
        const nowIso = new Date().toISOString();
        const deletedAt =
          detail?.thread.deletedAt != null ? DateTime.formatIso(detail.thread.deletedAt) : null;
        const archivedAt =
          detail?.thread.archivedAt != null
            ? DateTime.formatIso(detail.thread.archivedAt)
            : deletedAt === null
              ? nowIso
              : null;
        const closingShell = {
          ...previousEntry.shell,
          updatedAt: nowIso,
          archivedAt,
          deletedAt,
        };
        const closingEntry: SyncEntry = {
          ...previousEntry,
          shell: closingShell,
          shellFingerprint: buildShellFingerprint({
            shell: closingShell,
            teamProjectId: previousEntry.teamProjectId,
            defaultViewId: previousEntry.defaultViewId,
          }),
          isActive: false,
        };
        pendingClosingEntriesByKeyRef.current.set(syncKey, closingEntry);
        latestEntryByKeyRef.current.set(syncKey, closingEntry);
      } else if (!pendingClosingEntriesByKeyRef.current.has(syncKey)) {
        latestEntryByKeyRef.current.delete(syncKey);
        syncedShellFingerprintByKeyRef.current.delete(syncKey);
        syncedPayloadFingerprintByKeyRef.current.delete(syncKey);
        streamingThrottleRef.current?.clear(syncKey);
        retryAttemptsByKeyRef.current.delete(syncKey);
        retryScheduledFingerprintByKeyRef.current.delete(syncKey);
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

    const executeSync = (syncKey: string, options?: { readonly force?: boolean }) => {
      const entry = latestEntryByKeyRef.current.get(syncKey);
      if (!entry) return;
      const isClosingRequest = pendingClosingEntriesByKeyRef.current.get(syncKey) === entry;
      if (!liveTeamEnvIdsRef.current.has(entry.teamEnvironmentId)) {
        return;
      }
      const basePayload = buildLocalSyncPayload({
        localEnvironmentId: entry.localEnvironmentId,
        localEnvironmentLabel: entry.localEnvironmentLabel,
        teamProjectId: entry.teamProjectId,
        defaultViewId: entry.defaultViewId,
        initialLocked: entry.initialLocked,
        shell: entry.shell,
      });
      const fingerprint = JSON.stringify({ ...basePayload, syncSeq: undefined });
      if (syncedPayloadFingerprintByKeyRef.current.get(syncKey) === fingerprint) {
        syncedShellFingerprintByKeyRef.current.set(syncKey, entry.shellFingerprint);
        if (isClosingRequest) {
          pendingClosingEntriesByKeyRef.current.delete(syncKey);
          if (latestEntryByKeyRef.current.get(syncKey) === entry) {
            latestEntryByKeyRef.current.delete(syncKey);
          }
          syncedShellFingerprintByKeyRef.current.delete(syncKey);
          syncedPayloadFingerprintByKeyRef.current.delete(syncKey);
          streamingThrottleRef.current?.clear(syncKey);
          retryAttemptsByKeyRef.current.delete(syncKey);
          retryScheduledFingerprintByKeyRef.current.delete(syncKey);
        } else {
          releaseSubscriptionIfSettled(syncKey);
        }
        return;
      }
      if (!options?.force) {
        const scheduledFingerprint = retryScheduledFingerprintByKeyRef.current.get(syncKey);
        if (
          scheduledFingerprint === fingerprint &&
          (retryTimerByKeyRef.current.has(syncKey) ||
            (retryAttemptsByKeyRef.current.get(syncKey) ?? 0) >= MAX_SYNC_RETRIES)
        ) {
          return;
        }
      }
      const inFlightFingerprint = syncInFlightFingerprintByKeyRef.current.get(syncKey);
      if (inFlightFingerprint !== undefined) {
        if (inFlightFingerprint !== fingerprint) {
          pendingRetryByKeyRef.current.set(syncKey, entry);
        }
        return;
      }
      const existingTimer = retryTimerByKeyRef.current.get(syncKey);
      if (existingTimer !== undefined) {
        clearTimeout(existingTimer);
        retryTimerByKeyRef.current.delete(syncKey);
      }
      syncInFlightFingerprintByKeyRef.current.set(syncKey, fingerprint);
      pendingRetryByKeyRef.current.delete(syncKey);
      void syncLocalThread({
        environmentId: entry.teamEnvironmentId,
        input: basePayload,
      })
        .then((result) => {
          if (result._tag === "Success") {
            syncedPayloadFingerprintByKeyRef.current.set(syncKey, fingerprint);
            syncedShellFingerprintByKeyRef.current.set(syncKey, entry.shellFingerprint);
            retryAttemptsByKeyRef.current.delete(syncKey);
            retryScheduledFingerprintByKeyRef.current.delete(syncKey);
            if (isClosingRequest) {
              if (pendingClosingEntriesByKeyRef.current.get(syncKey) === entry) {
                pendingClosingEntriesByKeyRef.current.delete(syncKey);
                if (latestEntryByKeyRef.current.get(syncKey) === entry) {
                  latestEntryByKeyRef.current.delete(syncKey);
                }
                syncedShellFingerprintByKeyRef.current.delete(syncKey);
                syncedPayloadFingerprintByKeyRef.current.delete(syncKey);
                streamingThrottleRef.current?.clear(syncKey);
              }
            } else {
              releaseSubscriptionIfSettled(syncKey);
            }
          } else {
            const squashed = squashAtomCommandFailure(result);
            if (isPermanentSyncError(squashed)) {
              retryAttemptsByKeyRef.current.delete(syncKey);
              retryScheduledFingerprintByKeyRef.current.delete(syncKey);
              if (
                isClosingRequest &&
                pendingClosingEntriesByKeyRef.current.get(syncKey) === entry
              ) {
                pendingClosingEntriesByKeyRef.current.delete(syncKey);
                if (latestEntryByKeyRef.current.get(syncKey) === entry) {
                  latestEntryByKeyRef.current.delete(syncKey);
                }
              }
              return;
            }
            const attempt = (retryAttemptsByKeyRef.current.get(syncKey) ?? 0) + 1;
            retryAttemptsByKeyRef.current.set(syncKey, attempt);
            retryScheduledFingerprintByKeyRef.current.set(syncKey, fingerprint);
            if (attempt <= MAX_SYNC_RETRIES) {
              const delayMs = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
              const timer = setTimeout(() => {
                retryTimerByKeyRef.current.delete(syncKey);
                executeSyncRef.current(syncKey, { force: true });
              }, delayMs);
              retryTimerByKeyRef.current.set(syncKey, timer);
            }
          }
        })
        .finally(() => {
          syncInFlightFingerprintByKeyRef.current.delete(syncKey);
          const pending = pendingRetryByKeyRef.current.get(syncKey);
          if (pending) {
            pendingRetryByKeyRef.current.delete(syncKey);
            scheduleSync(pending.syncKey);
          }
        });
    };

    executeSyncRef.current = executeSync;

    const scheduleSync = (syncKey: string, options?: { readonly immediate?: boolean }) => {
      const entry = latestEntryByKeyRef.current.get(syncKey);
      if (!entry) return;
      const isClosingRequest = pendingClosingEntriesByKeyRef.current.get(syncKey) === entry;
      streamingThrottleRef.current?.schedule(syncKey, {
        isActive: entry.isActive && !isClosingRequest,
        immediate: options?.immediate === true || isClosingRequest,
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
          scheduleSync(syncKey);
        });
        subscriptionsByKeyRef.current.set(syncKey, unsubscribe);
      }
      scheduleSync(syncKey);
    }

    for (const syncKey of pendingClosingEntriesByKeyRef.current.keys()) {
      scheduleSync(syncKey, { immediate: true });
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
          const settings = getClientSettings();
          const { notificationMode: mode, inAppNotificationsEnabled } = settings;
          const teamId = state.team.id;
          const soundPreset = resolveTeamNotificationSoundPreset({
            teamId,
            teamNotificationSounds: settings.teamNotificationSounds,
          });
          if (hasNotificationSound(mode) && soundPreset !== "off") {
            void playNotificationSound(
              "input",
              () => {
                const latest = getClientSettings();
                return (
                  hasNotificationSound(latest.notificationMode) &&
                  resolveTeamNotificationSoundPreset({
                    teamId,
                    teamNotificationSounds: latest.teamNotificationSounds,
                  }) !== "off"
                );
              },
              soundPreset,
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
            try {
              const desktopNotification = new Notification(title, {
                body: bodyPreview,
                tag: `team-note:${note.id}`,
                silent: true,
              });
              desktopNotification.onclick = () => {
                window.focus();
                void router.navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId: targetEnvId, threadId: threadId as ThreadId },
                });
              };
            } catch {
              // Some browsers expose Notification but reject desktop presentation.
            }
          }
        }
      }
      initializedTeamEnvsRef.current.add(teamEnvId);
    }
  }, [router, teamStates]);

  // 3. Milestone 6: Sync connected Team Servers' providers, project mappings, member token,
  // and live assetsRevision to the local primary t3server so virtual team:<teamId>:* instances
  // and isolated team skill/pre-prompt profiles stay automatically provisioned.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes Team Server provider/asset bindings to local t3server as team state updates
  useEffect(() => {
    if (!primaryEnvironmentId) return;
    const activeTeamIds = new Set<TeamId>();
    const connectedActiveEnvIds = new Set<EnvironmentId>();
    const envById = new Map(environments.map((env) => [env.environmentId, env] as const));

    for (const [teamEnvId, state] of teamStates) {
      if (teamEnvId === primaryEnvironmentId) continue;
      if (
        state.team === null ||
        state.currentMember === null ||
        state.currentMember.status !== "active"
      ) {
        continue;
      }
      connectedActiveEnvIds.add(teamEnvId);
    }

    // Evict cached sync tokens for any environment that disconnected, lost active membership,
    // or was removed (disconnected environments are omitted from `teamStates`), so reconnecting
    // with a fresh AuthSession always mints and pushes a new local-sync token.
    for (const trackedEnvId of connectedActiveMemberByEnvIdRef.current.keys()) {
      if (connectedActiveEnvIds.has(trackedEnvId)) continue;
      connectedActiveMemberByEnvIdRef.current.delete(trackedEnvId);
      localSyncTokenByTeamEnvRef.current.delete(trackedEnvId);
      for (const [boundTeamId, boundEnvId] of envIdByBoundTeamIdRef.current) {
        if (boundEnvId === trackedEnvId) {
          syncedBindingFingerprintByTeamIdRef.current.delete(boundTeamId);
        }
      }
    }

    for (const [teamEnvId, state] of teamStates) {
      if (teamEnvId === primaryEnvironmentId) continue;
      if (
        state.team === null ||
        state.currentMember === null ||
        state.currentMember.status !== "active"
      ) {
        continue;
      }
      const env = envById.get(teamEnvId);
      const teamServerUrl = env?.displayUrl ?? null;
      if (!teamServerUrl) continue;

      const teamId = state.team.id;
      const teamName = state.team.name;
      const previousConnectedMember = connectedActiveMemberByEnvIdRef.current.get(teamEnvId);
      if (previousConnectedMember !== state.currentMember.id) {
        connectedActiveMemberByEnvIdRef.current.set(teamEnvId, state.currentMember.id);
        localSyncTokenByTeamEnvRef.current.delete(teamEnvId);
        syncedBindingFingerprintByTeamIdRef.current.delete(teamId);
      }
      activeTeamIds.add(teamId);
      envIdByBoundTeamIdRef.current.set(teamId, teamEnvId);

      const localProjects = projects.filter(
        (project) => project.environmentId === primaryEnvironmentId,
      );
      const projectsPayload = state.teamProjects.map((assignment) => {
        const matchedLocal =
          localProjects.find((p) => p.id === assignment.projectId) ??
          (assignment.repoIdentityKey !== null
            ? localProjects.find(
                (p) =>
                  (p.repositoryIdentity?.origin?.canonicalKey ??
                    p.repositoryIdentity?.canonicalKey ??
                    null) === assignment.repoIdentityKey,
              )
            : undefined);
        return {
          localProjectId: matchedLocal?.id ?? assignment.projectId,
          teamProjectId: assignment.projectId,
          repoIdentityKey: assignment.repoIdentityKey,
        };
      });
      const bindingFingerprint = JSON.stringify({
        teamId,
        teamName,
        teamServerUrl,
        providers: state.providers,
        projects: projectsPayload,
      });

      const previousBindingFingerprint = syncedBindingFingerprintByTeamIdRef.current.get(teamId);
      const previousRevision = syncedAssetsRevisionByTeamIdRef.current.get(teamId) ?? -1;

      if (previousBindingFingerprint !== bindingFingerprint) {
        syncedBindingFingerprintByTeamIdRef.current.set(teamId, bindingFingerprint);
        boundTeamIdsRef.current.add(teamId);
        void (async () => {
          let memberToken = localSyncTokenByTeamEnvRef.current.get(teamEnvId);
          if (!memberToken) {
            const issued = await issueLocalSyncToken({
              environmentId: teamEnvId,
              input: {},
            });
            if (issued._tag === "Success") {
              memberToken = issued.value.token;
              localSyncTokenByTeamEnvRef.current.set(teamEnvId, memberToken);
            } else {
              // Retry issuing token on next state update instead of binding permanently without credentials.
              syncedBindingFingerprintByTeamIdRef.current.delete(teamId);
              return;
            }
          }
          const synced = await syncLocalBinding({
            environmentId: primaryEnvironmentId,
            input: {
              teamId,
              teamName,
              teamServerUrl,
              memberToken,
              providers: [...state.providers],
              projects: projectsPayload,
              assetsRevision: NonNegativeInt.make(Math.max(0, state.assetsRevision)),
            },
          });
          if (synced._tag === "Success") {
            syncedAssetsRevisionByTeamIdRef.current.set(teamId, synced.value.assetsRevision);
          } else {
            // Allow retry on next state update if local binding failed transiently.
            syncedBindingFingerprintByTeamIdRef.current.delete(teamId);
          }
        })();
      } else if (state.assetsRevision > previousRevision) {
        syncedAssetsRevisionByTeamIdRef.current.set(teamId, state.assetsRevision);
        void notifyLocalAssetsUpdated({
          environmentId: primaryEnvironmentId,
          input: {
            teamId,
            revision: NonNegativeInt.make(Math.max(0, state.assetsRevision)),
          },
        });
      }
    }

    // Only purge local bindings when the Team Server environment was explicitly removed
    // OR the Team Server affirmatively reports that membership is no longer active.
    // Transient offline/disconnect states (state.team === null while env stays registered)
    // preserve local bindings so offline laptops keep their team providers and skills.
    for (const previousTeamId of boundTeamIdsRef.current) {
      if (activeTeamIds.has(previousTeamId)) continue;
      const boundEnvId = envIdByBoundTeamIdRef.current.get(previousTeamId);
      const envStillRegistered = boundEnvId !== undefined && envById.has(boundEnvId);
      const envTeamState = boundEnvId !== undefined ? teamStates.get(boundEnvId) : undefined;
      const explicitlyRevoked =
        envTeamState?.team !== null &&
        envTeamState?.currentMember !== null &&
        envTeamState?.currentMember !== undefined &&
        envTeamState.currentMember.status !== "active";
      if (!envStillRegistered || explicitlyRevoked) {
        boundTeamIdsRef.current.delete(previousTeamId);
        envIdByBoundTeamIdRef.current.delete(previousTeamId);
        syncedBindingFingerprintByTeamIdRef.current.delete(previousTeamId);
        syncedAssetsRevisionByTeamIdRef.current.delete(previousTeamId);
        if (boundEnvId !== undefined) {
          localSyncTokenByTeamEnvRef.current.delete(boundEnvId);
        }
        void removeLocalBinding({
          environmentId: primaryEnvironmentId,
          input: { teamId: previousTeamId },
        });
      }
    }
  }, [
    environments,
    issueLocalSyncToken,
    notifyLocalAssetsUpdated,
    primaryEnvironmentId,
    projects,
    removeLocalBinding,
    syncLocalBinding,
    teamStates,
  ]);

  return null;
}
