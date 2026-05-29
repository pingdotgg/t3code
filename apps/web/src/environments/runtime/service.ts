import {
  type AuthSessionRole,
  type DesktopSshEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
  type EnvironmentId,
  type OrchestrationEvent,
  type OrchestrationThreadDetailFingerprint,
  type OrchestrationThreadShell,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamEvent,
  type ServerConfig,
  type TerminalEvent,
  ThreadId,
} from "@t3tools/contracts";
import { type QueryClient } from "@tanstack/react-query";
import { Throttler } from "@tanstack/react-pacer";
import {
  createKnownEnvironment,
  getKnownEnvironmentWsBaseUrl,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime";

import {
  markPromotedDraftThreadByRef,
  markPromotedDraftThreadsByRef,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { ensureLocalApi } from "~/localApi";
import { collectActiveTerminalThreadIds } from "~/lib/terminalStateCleanup";
import { deriveOrchestrationBatchEffects } from "~/orchestrationEventEffects";
import { projectQueryKeys } from "~/lib/projectReactQuery";
import { providerQueryKeys } from "~/lib/providerReactQuery";
import { getPrimaryKnownEnvironment } from "../primary";
import {
  bootstrapRemoteBearerSession,
  fetchRemoteEnvironmentDescriptor,
  fetchRemoteSessionState,
  isRemoteEnvironmentAuthHttpError,
  resolveRemoteWebSocketConnectionUrl,
} from "../remote/api";
import type { NotificationNavigationTarget } from "../../push/notificationNavigation";
import { resolveRemotePairingTarget } from "../remote/target";
import {
  getSavedEnvironmentRecord,
  hasSavedEnvironmentRegistryHydrated,
  listSavedEnvironmentRecords,
  persistSavedEnvironmentRecord,
  readSavedEnvironmentBearerToken,
  removeSavedEnvironmentBearerToken,
  type SavedEnvironmentRecord,
  toPersistedSavedEnvironmentRecord,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
  waitForSavedEnvironmentRegistryHydration,
  writeSavedEnvironmentBearerToken,
} from "./catalog";
import {
  createEnvironmentConnection,
  isEnvironmentShellBootstrapTimeoutError,
  type EnvironmentConnection,
} from "./connection";
import {
  useStore,
  selectProjectsAcrossEnvironments,
  selectSidebarThreadSummaryByRef,
  selectThreadByRef,
  selectThreadsAcrossEnvironments,
} from "~/store";
import { computeOrchestrationThreadDetailFingerprint } from "@t3tools/shared/orchestrationThreadDetailFingerprint";
import { useTerminalStateStore } from "~/terminalStateStore";
import { useUiStateStore } from "~/uiStateStore";
import type { WsProtocolCloseContext } from "../../rpc/protocol";
import { getServerConfig } from "../../rpc/serverState";
import { isTransportConnectionErrorMessage } from "../../rpc/transportError";
import { WsTransport } from "../../rpc/wsTransport";
import { createWsRpcClient, type WsRpcClient } from "../../rpc/wsRpcClient";
import { appendVersionMismatchHint, resolveServerConfigVersionMismatch } from "../../versionSkew";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
} from "../../logicalProject";
import { flushResumeDiagnostics, recordResumeDiagnostic } from "./resumeDiagnostics";
import { getClientSettings } from "~/hooks/useSettings";
import {
  readCachedEnvironmentState,
  removeCachedEnvironmentState,
  scheduleCachedEnvironmentStateWrite,
} from "~/orchestrationStartupCache";
import type { Thread } from "~/types";

type EnvironmentServiceState = {
  readonly queryClient: QueryClient;
  readonly queryInvalidationThrottler: Throttler<() => void>;
  refCount: number;
  stop: () => void;
};

type ThreadDetailSubscriptionEntry = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  unsubscribe: () => void;
  unsubscribeConnectionListener: (() => void) | null;
  refCount: number;
  activeRefCount: number;
  latestDetailSequence: number | null;
  verifiedDetailSequence: number | null;
  verifiedDetailFingerprint: OrchestrationThreadDetailFingerprint | null;
  resetDetailSequenceOnNextSnapshot: boolean;
  reconcileOnNextActiveRetain: boolean;
  reconcileTimeoutId: ReturnType<typeof setTimeout> | null;
  reconcileInFlight: boolean;
  reconcileRequestedWhileInFlight: boolean;
  activeReconcileIntervalId: ReturnType<typeof setInterval> | null;
  lastActiveReconcileTickAt: number | null;
  lastActiveWakeRefreshAt: number | null;
  lastActiveDetailReconcileAt: number | null;
  lastAccessedAt: number;
  evictionTimeoutId: ReturnType<typeof setTimeout> | null;
};

const environmentConnections = new Map<EnvironmentId, EnvironmentConnection>();
class SavedEnvironmentConnectionCancelledError extends Error {
  constructor(environmentId: EnvironmentId) {
    super(`Saved environment ${environmentId} connection was cancelled.`);
    this.name = "SavedEnvironmentConnectionCancelledError";
  }
}

function isSavedEnvironmentConnectionCancelledError(
  error: unknown,
): error is SavedEnvironmentConnectionCancelledError {
  return error instanceof SavedEnvironmentConnectionCancelledError;
}

interface PendingSavedEnvironmentConnection {
  cancelled: boolean;
  readonly promise: Promise<EnvironmentConnection>;
}

interface ProjectionRecovery {
  highestObservedSequence: number;
  promise: Promise<void>;
}

interface ConnectionHealthRecovery {
  failureCount: number;
  nextAllowedAt: number;
  promise: Promise<void> | null;
}

interface RecentBrowserResumeContext {
  readonly reason: string;
  readonly hiddenDurationMs: number;
  readonly forceReconnect: boolean;
  readonly resumedAt: number;
}

interface NotificationClickReconcileMetadata {
  readonly openedAt?: number;
}

type NotificationHiddenDurationSource = "direct" | "recent-resume" | "none";

interface BrowserResumeReconcileOptions {
  readonly hiddenDurationMs: number | null;
  readonly forceReconnect: boolean;
  readonly reconnectRetryCount: number;
}

interface BrowserResumeQueuedFollowUp {
  readonly reason: string;
  readonly options: BrowserResumeReconcileOptions;
}

interface BrowserResumeReconciliationState {
  readonly promise: Promise<void>;
  readonly reason: string;
  readonly forceReconnect: boolean;
  queuedFollowUp: BrowserResumeQueuedFollowUp | null;
}

interface PendingNotificationThreadReconcile {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface BrowserResumeShellBootstrapTimeoutState {
  readonly failedAt: number;
  readonly reconnectRetryCount: number;
  readonly timeoutMs: number;
}

interface RecoveredEventBatchOptions {
  readonly preserveShellFields?: boolean;
  readonly syncSidebarSummaries?: boolean;
}

const pendingSavedEnvironmentConnections = new Map<
  EnvironmentId,
  PendingSavedEnvironmentConnection
>();
const environmentConnectionListeners = new Set<() => void>();
const threadDetailSubscriptions = new Map<string, ThreadDetailSubscriptionEntry>();
const browserResumeReconciliationByEnvironment = new Map<
  EnvironmentId,
  BrowserResumeReconciliationState
>();
const activeThreadProjectionReconciliationByEnvironment = new Map<EnvironmentId, Promise<void>>();
const lastAppliedProjectionVersionByEnvironment = new Map<
  EnvironmentId,
  {
    readonly sequence: number;
    readonly updatedAt: string | null;
  }
>();
const projectionRecoveryByEnvironment = new Map<EnvironmentId, ProjectionRecovery>();
const connectionHealthRecoveryByEnvironment = new Map<EnvironmentId, ConnectionHealthRecovery>();

let activeService: EnvironmentServiceState | null = null;
let needsProviderInvalidation = false;
let lastBrowserHiddenAt: number | null = null;
let recentBrowserResumeContext: RecentBrowserResumeContext | null = null;
let lastBrowserResumeReconcileAt = Number.NEGATIVE_INFINITY;
const pendingNotificationThreadReconcileKeys = new Map<
  string,
  PendingNotificationThreadReconcile
>();
let pendingNotificationThreadReconcilesHydrated = false;
const pendingNotificationThreadReconcileConsumeDiagnostics = new Map<
  string,
  {
    readonly retainedReason: string | null;
    readonly loggedAt: number;
  }
>();
const browserResumeReconnectRetryByEnvironment = new Map<
  EnvironmentId,
  BrowserResumeQueuedFollowUp
>();
const browserResumeShellBootstrapTimeoutByEnvironment = new Map<
  EnvironmentId,
  BrowserResumeShellBootstrapTimeoutState
>();
const browserResumeReconnectRetryTimeoutIds = new Set<ReturnType<typeof setTimeout>>();

// Thread detail subscription cache policy:
// - Active consumers keep a subscription retained via refCount.
// - Released subscriptions stay warm for a longer idle TTL to avoid churn
//   while moving around the UI.
// - Threads with active work or pending user action are sticky and are never
//   evicted while they remain non-idle.
// - Capacity eviction only targets idle cached subscriptions.
const THREAD_DETAIL_SUBSCRIPTION_IDLE_EVICTION_MS = 15 * 60 * 1000;
const MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS = 32;
const THREAD_DETAIL_REFRESH_AFTER_SHELL_ADVANCE_MS = 250;
const THREAD_DETAIL_ACTIVE_RECONCILE_INTERVAL_MS = 5_000;
const THREAD_DETAIL_ACTIVE_RECONCILE_WAKE_DRIFT_MS = 15_000;
const THREAD_DETAIL_ACTIVE_WAKE_REFRESH_COOLDOWN_MS = 30_000;
const THREAD_DETAIL_ACTIVE_RECONCILE_FIRST_PING_MS = 10_000;
const THREAD_DETAIL_ACTIVE_RECONCILE_COOLDOWN_MS = 30_000;
const CONNECTION_HEALTH_RECOVERY_COOLDOWN_MS = 30_000;
const CONNECTION_HEALTH_RECOVERY_BACKOFF_BASE_MS = 30_000;
const CONNECTION_HEALTH_RECOVERY_BACKOFF_MAX_MS = 2 * 60_000;
const CONNECTION_HEALTH_RECOVERY_RECONNECT_TIMEOUT_MS = 15_000;
const BROWSER_RESUME_RECONCILE_COOLDOWN_MS = 2_000;
const BROWSER_RESUME_RECONCILE_TIMEOUT_MS = 1_500;
const BROWSER_RESUME_HEARTBEAT_TICK_MS = 15_000;
const BROWSER_RESUME_LONG_BACKGROUND_MS = 5_000;
const BROWSER_RESUME_RECONNECT_BOOTSTRAP_TIMEOUT_MS = 12_000;
const BROWSER_RESUME_RECONNECT_RETRY_DELAY_MS = 500;
const BROWSER_RESUME_RECONNECT_MAX_RETRY_COUNT = 1;
const RECENT_BROWSER_RESUME_CONTEXT_TTL_MS = 30_000;
const PENDING_NOTIFICATION_THREAD_RECONCILE_STORAGE_KEY =
  "t3.pending-notification-thread-reconciles";
const PENDING_NOTIFICATION_THREAD_RECONCILE_TTL_MS = 5 * 60_000;
const PENDING_NOTIFICATION_THREAD_RECONCILE_CONSUME_DIAGNOSTIC_INTERVAL_MS = 5_000;
const INITIAL_SERVER_CONFIG_SNAPSHOT_WAIT_MS = 150;
const NOOP = () => undefined;
const SSH_HTTP_STATUS_RE = /^\[ssh_http:(\d+)\]\s/u;

function createDeferredPromise<T>() {
  let resolve: ((value: T) => void) | null = null;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });

  return {
    promise,
    resolve: (value: T) => {
      resolve?.(value);
      resolve = null;
    },
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  createError: () => Error,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return new Promise<T>((resolve, reject) => {
    const clear = () => {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    timeoutId = setTimeout(() => {
      timeoutId = null;
      reject(createError());
    }, timeoutMs);

    promise.then(
      (value) => {
        clear();
        resolve(value);
      },
      (error) => {
        clear();
        reject(error);
      },
    );
  });
}

function getBrowserHiddenDuration(now: number): number | null {
  return lastBrowserHiddenAt === null ? null : Math.max(0, now - lastBrowserHiddenAt);
}

function makeBrowserResumeReconcileOptions(
  reason: string,
  hiddenDurationMs: number | null,
): BrowserResumeReconcileOptions {
  return {
    hiddenDurationMs,
    reconnectRetryCount: 0,
    forceReconnect:
      reason !== "heartbeat-tick" &&
      hiddenDurationMs !== null &&
      hiddenDurationMs > BROWSER_RESUME_LONG_BACKGROUND_MS,
  };
}

function rememberRecentBrowserResumeContext(
  reason: string,
  hiddenDurationMs: number | null,
  options: BrowserResumeReconcileOptions,
  resumedAt: number,
): void {
  if (hiddenDurationMs === null) {
    return;
  }
  recentBrowserResumeContext = {
    reason,
    hiddenDurationMs,
    forceReconnect: options.forceReconnect,
    resumedAt,
  };
}

function readRecentBrowserResumeContext(
  now: number,
): { readonly context: RecentBrowserResumeContext; readonly ageMs: number } | null {
  if (recentBrowserResumeContext === null) {
    return null;
  }
  const ageMs = Math.max(0, now - recentBrowserResumeContext.resumedAt);
  if (ageMs > RECENT_BROWSER_RESUME_CONTEXT_TTL_MS) {
    recentBrowserResumeContext = null;
    return null;
  }
  return {
    context: recentBrowserResumeContext,
    ageMs,
  };
}

function sanitizeNotificationOpenedAt(openedAt: number | undefined): number | null {
  return openedAt !== undefined && Number.isFinite(openedAt) ? openedAt : null;
}

function resolveNotificationClickHiddenDuration(now: number): {
  readonly hiddenDurationMs: number | null;
  readonly hiddenDurationSource: NotificationHiddenDurationSource;
  readonly resumeSignalAgeMs: number | null;
  readonly recentResumeReason: string | null;
  readonly recentResumeForceReconnect: boolean | null;
} {
  const directHiddenDurationMs = getBrowserHiddenDuration(now);
  if (directHiddenDurationMs !== null) {
    return {
      hiddenDurationMs: directHiddenDurationMs,
      hiddenDurationSource: "direct",
      resumeSignalAgeMs: null,
      recentResumeReason: null,
      recentResumeForceReconnect: null,
    };
  }

  const recent = readRecentBrowserResumeContext(now);
  if (recent !== null) {
    return {
      hiddenDurationMs: recent.context.hiddenDurationMs,
      hiddenDurationSource: "recent-resume",
      resumeSignalAgeMs: recent.ageMs,
      recentResumeReason: recent.context.reason,
      recentResumeForceReconnect: recent.context.forceReconnect,
    };
  }

  return {
    hiddenDurationMs: null,
    hiddenDurationSource: "none",
    resumeSignalAgeMs: null,
    recentResumeReason: null,
    recentResumeForceReconnect: null,
  };
}

function getPendingNotificationThreadReconcileStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function isPendingNotificationThreadReconcile(
  value: unknown,
): value is PendingNotificationThreadReconcile {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.environmentId === "string" &&
    record.environmentId.length > 0 &&
    typeof record.threadId === "string" &&
    record.threadId.length > 0 &&
    Number.isFinite(record.createdAt) &&
    Number.isFinite(record.updatedAt)
  );
}

function isPendingNotificationThreadReconcileExpired(
  pending: PendingNotificationThreadReconcile,
  now: number,
): boolean {
  return now - pending.updatedAt > PENDING_NOTIFICATION_THREAD_RECONCILE_TTL_MS;
}

function persistPendingNotificationThreadReconciles(): void {
  const storage = getPendingNotificationThreadReconcileStorage();
  if (!storage) {
    return;
  }
  try {
    if (pendingNotificationThreadReconcileKeys.size === 0) {
      storage.removeItem(PENDING_NOTIFICATION_THREAD_RECONCILE_STORAGE_KEY);
      return;
    }
    storage.setItem(
      PENDING_NOTIFICATION_THREAD_RECONCILE_STORAGE_KEY,
      JSON.stringify([...pendingNotificationThreadReconcileKeys.values()]),
    );
  } catch {
    // Pending notification recovery must not affect normal resume behavior.
  }
}

function pruneExpiredPendingNotificationThreadReconciles(now: number): void {
  let pruned = 0;
  for (const [key, pending] of pendingNotificationThreadReconcileKeys) {
    if (!isPendingNotificationThreadReconcileExpired(pending, now)) {
      continue;
    }
    pendingNotificationThreadReconcileKeys.delete(key);
    pendingNotificationThreadReconcileConsumeDiagnostics.delete(key);
    pruned += 1;
    recordResumeDiagnostic("notification-thread-reconcile-expired", {
      env: pending.environmentId,
      data: {
        threadId: pending.threadId,
        pendingAgeMs: now - pending.createdAt,
        pendingUpdatedAgeMs: now - pending.updatedAt,
        pendingCount: pendingNotificationThreadReconcileKeys.size,
      },
    });
  }
  if (pruned > 0) {
    persistPendingNotificationThreadReconciles();
  }
}

function hydratePendingNotificationThreadReconciles(now: number): void {
  if (pendingNotificationThreadReconcilesHydrated) {
    pruneExpiredPendingNotificationThreadReconciles(now);
    return;
  }
  pendingNotificationThreadReconcilesHydrated = true;

  const storage = getPendingNotificationThreadReconcileStorage();
  if (!storage) {
    pruneExpiredPendingNotificationThreadReconciles(now);
    return;
  }

  let changed = false;
  try {
    const raw = storage.getItem(PENDING_NOTIFICATION_THREAD_RECONCILE_STORAGE_KEY);
    if (!raw) {
      pruneExpiredPendingNotificationThreadReconciles(now);
      return;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      changed = true;
    } else {
      for (const item of parsed) {
        if (!isPendingNotificationThreadReconcile(item)) {
          changed = true;
          continue;
        }
        if (isPendingNotificationThreadReconcileExpired(item, now)) {
          changed = true;
          recordResumeDiagnostic("notification-thread-reconcile-expired", {
            env: item.environmentId,
            data: {
              threadId: item.threadId,
              pendingAgeMs: now - item.createdAt,
              pendingUpdatedAgeMs: now - item.updatedAt,
              pendingCount: pendingNotificationThreadReconcileKeys.size,
            },
          });
          continue;
        }
        pendingNotificationThreadReconcileKeys.set(
          getThreadDetailSubscriptionKey(item.environmentId, item.threadId),
          item,
        );
      }
    }
  } catch {
    changed = true;
  }

  pruneExpiredPendingNotificationThreadReconciles(now);
  if (changed) {
    persistPendingNotificationThreadReconciles();
  }
}

function setPendingNotificationThreadReconcile(
  target: Extract<NotificationNavigationTarget, { kind: "thread" }>,
  now: number,
): void {
  hydratePendingNotificationThreadReconciles(now);
  const key = getThreadDetailSubscriptionKey(target.environmentId, target.threadId);
  const existing = pendingNotificationThreadReconcileKeys.get(key);
  pendingNotificationThreadReconcileKeys.set(key, {
    environmentId: target.environmentId,
    threadId: target.threadId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  pendingNotificationThreadReconcileConsumeDiagnostics.delete(key);
  persistPendingNotificationThreadReconciles();
  recordResumeDiagnostic("notification-thread-reconcile-pending", {
    reason: "notification-click",
    env: target.environmentId,
    data: {
      threadId: target.threadId,
      pendingCount: pendingNotificationThreadReconcileKeys.size,
    },
  });
}

function deletePendingNotificationThreadReconcile(key: string): boolean {
  const deleted = pendingNotificationThreadReconcileKeys.delete(key);
  if (deleted) {
    pendingNotificationThreadReconcileConsumeDiagnostics.delete(key);
    persistPendingNotificationThreadReconciles();
  }
  return deleted;
}

async function waitForConfigSnapshot(
  promise: Promise<ServerConfig>,
  timeoutMs: number,
): Promise<ServerConfig | null> {
  return await new Promise<ServerConfig | null>((resolve) => {
    const timeoutId = globalThis.setTimeout(() => resolve(null), timeoutMs);
    promise.then(
      (config) => {
        clearTimeout(timeoutId);
        resolve(config);
      },
      () => {
        clearTimeout(timeoutId);
        resolve(null);
      },
    );
  });
}

function createSavedEnvironmentSyncScheduler() {
  let activeSync: Promise<void> | null = null;
  let queued = false;

  const run = async (): Promise<void> => {
    do {
      queued = false;
      await syncSavedEnvironmentConnections(listSavedEnvironmentRecords());
    } while (queued);
  };

  return () => {
    if (activeSync) {
      queued = true;
      return activeSync;
    }

    activeSync = run()
      .catch(() => undefined)
      .finally(() => {
        activeSync = null;
      });

    return activeSync;
  };
}
function compareAppliedProjectionVersion(
  left: { readonly sequence: number; readonly updatedAt: string | null },
  right: { readonly sequence: number; readonly updatedAt: string | null },
): number {
  if (left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }

  const leftUpdatedAt = left.updatedAt ?? "";
  const rightUpdatedAt = right.updatedAt ?? "";
  if (leftUpdatedAt === rightUpdatedAt) {
    return 0;
  }

  return leftUpdatedAt < rightUpdatedAt ? -1 : 1;
}

function toAppliedProjectionVersion(
  snapshot: Pick<OrchestrationShellSnapshot, "snapshotSequence" | "updatedAt">,
): {
  readonly sequence: number;
  readonly updatedAt: string;
} {
  return {
    sequence: snapshot.snapshotSequence,
    updatedAt: snapshot.updatedAt,
  };
}

export function shouldApplyProjectionSnapshot(input: {
  readonly current: {
    readonly sequence: number;
    readonly updatedAt: string | null;
  } | null;
  readonly next: Pick<OrchestrationShellSnapshot, "snapshotSequence" | "updatedAt">;
}): boolean {
  if (input.current === null) {
    return true;
  }

  return compareAppliedProjectionVersion(input.current, toAppliedProjectionVersion(input.next)) < 0;
}

export function shouldApplyProjectionEvent(input: {
  readonly current: {
    readonly sequence: number;
    readonly updatedAt: string | null;
  } | null;
  readonly sequence: number;
}): boolean {
  return classifyProjectionEvent(input) === "apply";
}

export function classifyProjectionEvent(input: {
  readonly current: {
    readonly sequence: number;
    readonly updatedAt: string | null;
  } | null;
  readonly sequence: number;
}): "apply" | "gap" | "stale" {
  if (input.current === null) {
    return "apply";
  }

  if (input.sequence <= input.current.sequence) {
    return "stale";
  }

  return input.sequence === input.current.sequence + 1 ? "apply" : "gap";
}

function readLastAppliedProjectionVersion(environmentId: EnvironmentId): {
  readonly sequence: number;
  readonly updatedAt: string | null;
} | null {
  return lastAppliedProjectionVersionByEnvironment.get(environmentId) ?? null;
}

function markAppliedProjectionSnapshot(
  environmentId: EnvironmentId,
  snapshot: Pick<OrchestrationShellSnapshot, "snapshotSequence" | "updatedAt">,
): void {
  const nextVersion = toAppliedProjectionVersion(snapshot);
  const currentVersion = readLastAppliedProjectionVersion(environmentId);
  if (
    currentVersion !== null &&
    compareAppliedProjectionVersion(currentVersion, nextVersion) >= 0
  ) {
    return;
  }

  lastAppliedProjectionVersionByEnvironment.set(environmentId, nextVersion);
}

function markAppliedProjectionEvent(environmentId: EnvironmentId, sequence: number): void {
  const currentVersion = readLastAppliedProjectionVersion(environmentId);
  if (currentVersion !== null && sequence <= currentVersion.sequence) {
    return;
  }

  lastAppliedProjectionVersionByEnvironment.set(environmentId, {
    sequence,
    updatedAt: currentVersion?.updatedAt ?? null,
  });
}

function noteProjectionRecoveryObservedSequence(
  environmentId: EnvironmentId,
  sequence: number,
): void {
  const existing = projectionRecoveryByEnvironment.get(environmentId);
  if (!existing) {
    return;
  }

  existing.highestObservedSequence = Math.max(existing.highestObservedSequence, sequence);
}

function applyRecoveredProjectionEventBatch(
  events: ReadonlyArray<OrchestrationEvent>,
  environmentId: EnvironmentId,
): void {
  if (events.length === 0) {
    return;
  }

  applyRecoveredEventBatch(events, environmentId, { syncSidebarSummaries: true });
  markAppliedProjectionEvent(environmentId, events.at(-1)?.sequence ?? 0);
  reconcileThreadDetailSubscriptionsAfterRecoveredEvents(events, environmentId);
}

function selectContiguousReplayEvents(
  events: ReadonlyArray<OrchestrationEvent>,
  currentSequence: number,
): ReadonlyArray<OrchestrationEvent> {
  const nextEvents = events
    .filter((event) => event.sequence > currentSequence)
    .toSorted((left, right) => left.sequence - right.sequence);
  const contiguousEvents: OrchestrationEvent[] = [];
  let expectedSequence = currentSequence + 1;

  for (const event of nextEvents) {
    if (event.sequence < expectedSequence) {
      continue;
    }
    if (event.sequence !== expectedSequence) {
      break;
    }

    contiguousEvents.push(event);
    expectedSequence += 1;
  }

  return contiguousEvents;
}

function getOrchestrationEventThreadId(event: OrchestrationEvent): ThreadId | null {
  return "threadId" in event.payload ? event.payload.threadId : null;
}

function isThreadDetailReplayEvent(event: OrchestrationEvent): boolean {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set"
  );
}

function reconcileThreadDetailSubscriptionsAfterRecoveredEvents(
  events: ReadonlyArray<OrchestrationEvent>,
  environmentId: EnvironmentId,
): void {
  for (const event of events) {
    const threadId = getOrchestrationEventThreadId(event);
    if (threadId === null) {
      continue;
    }

    const entry = threadDetailSubscriptions.get(
      getThreadDetailSubscriptionKey(environmentId, threadId),
    );
    if (!entry) {
      continue;
    }

    if (isThreadDetailReplayEvent(event)) {
      markThreadDetailSequence(entry, event.sequence);
    }
    scheduleThreadDetailReconcileIfBehind(environmentId, threadId, event.sequence);
  }
}

async function recoverProjectionSequenceGap(
  environmentId: EnvironmentId,
  recovery: ProjectionRecovery,
): Promise<void> {
  const connection = readEnvironmentConnection(environmentId);
  if (!connection) {
    return;
  }

  for (;;) {
    if (
      projectionRecoveryByEnvironment.get(environmentId) !== recovery ||
      readEnvironmentConnection(environmentId) !== connection
    ) {
      return;
    }

    const currentSequence = readLastAppliedProjectionVersion(environmentId)?.sequence ?? 0;
    const replayedEvents = await connection.client.orchestration.replayEvents({
      fromSequenceExclusive: currentSequence,
    });
    if (
      projectionRecoveryByEnvironment.get(environmentId) !== recovery ||
      readEnvironmentConnection(environmentId) !== connection
    ) {
      return;
    }

    const contiguousEvents = selectContiguousReplayEvents(replayedEvents, currentSequence);

    if (contiguousEvents.length === 0) {
      if (
        projectionRecoveryByEnvironment.get(environmentId) === recovery &&
        readEnvironmentConnection(environmentId) === connection
      ) {
        await connection.reconnect();
      }
      return;
    }

    applyRecoveredProjectionEventBatch(contiguousEvents, environmentId);

    const recoveredSequence = readLastAppliedProjectionVersion(environmentId)?.sequence ?? 0;
    if (recoveredSequence >= recovery.highestObservedSequence) {
      return;
    }
  }
}

function queueProjectionRecovery(environmentId: EnvironmentId, observedSequence: number): void {
  const existing = projectionRecoveryByEnvironment.get(environmentId);
  if (existing) {
    existing.highestObservedSequence = Math.max(existing.highestObservedSequence, observedSequence);
    return;
  }

  const recovery = {
    highestObservedSequence: observedSequence,
    promise: Promise.resolve(),
  };
  projectionRecoveryByEnvironment.set(environmentId, recovery);
  recovery.promise = recoverProjectionSequenceGap(environmentId, recovery)
    .catch((error) => {
      console.warn("Projection replay recovery failed", {
        environmentId,
        error: error instanceof Error ? error.message : String(error),
      });
      const connection = readEnvironmentConnection(environmentId);
      if (projectionRecoveryByEnvironment.get(environmentId) !== recovery || !connection) {
        return;
      }
      return connection.reconnect().catch((reconnectError) => {
        console.warn("Projection snapshot recovery failed", {
          environmentId,
          error: reconnectError instanceof Error ? reconnectError.message : String(reconnectError),
        });
      });
    })
    .finally(() => {
      if (projectionRecoveryByEnvironment.get(environmentId) === recovery) {
        projectionRecoveryByEnvironment.delete(environmentId);
      }
    });
}

function getConnectionHealthRecoveryBackoffMs(failureCount: number): number {
  return Math.min(
    CONNECTION_HEALTH_RECOVERY_BACKOFF_BASE_MS * 2 ** Math.max(0, failureCount - 1),
    CONNECTION_HEALTH_RECOVERY_BACKOFF_MAX_MS,
  );
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function shouldRecoverConnectionFromActiveProjectionError(error: unknown): boolean {
  return isTransportConnectionErrorMessage(formatUnknownError(error));
}

function queueEnvironmentConnectionHealthRecovery(
  connection: EnvironmentConnection,
  reason: string,
  cause?: unknown,
): void {
  const environmentId = connection.environmentId;
  const now = Date.now();
  const existing = connectionHealthRecoveryByEnvironment.get(environmentId);
  if (existing?.promise) {
    return;
  }
  if (existing && now < existing.nextAllowedAt) {
    return;
  }

  const recovery: ConnectionHealthRecovery = existing ?? {
    failureCount: 0,
    nextAllowedAt: 0,
    promise: null,
  };
  connectionHealthRecoveryByEnvironment.set(environmentId, recovery);
  recovery.promise = (async () => {
    console.warn("Environment connection health recovery reconnecting", {
      environmentId,
      reason,
      ...(cause !== undefined ? { cause: formatUnknownError(cause) } : {}),
    });
    try {
      await withTimeout(
        connection.reconnect(),
        CONNECTION_HEALTH_RECOVERY_RECONNECT_TIMEOUT_MS,
        () => new Error("Environment connection health recovery timed out."),
      );
      if (readEnvironmentConnection(environmentId) !== connection) {
        return;
      }
      recovery.failureCount = 0;
      recovery.nextAllowedAt = Date.now() + CONNECTION_HEALTH_RECOVERY_COOLDOWN_MS;
    } catch (error) {
      if (readEnvironmentConnection(environmentId) !== connection) {
        return;
      }
      recovery.failureCount += 1;
      recovery.nextAllowedAt =
        Date.now() + getConnectionHealthRecoveryBackoffMs(recovery.failureCount);
      console.warn("Environment connection health recovery failed", {
        environmentId,
        reason,
        error: formatUnknownError(error),
      });
    } finally {
      if (connectionHealthRecoveryByEnvironment.get(environmentId) === recovery) {
        recovery.promise = null;
      }
    }
  })();
}

function queueEnvironmentConnectionHealthRecoveryIfIdle(
  connection: EnvironmentConnection,
  reason: string,
  cause?: unknown,
): void {
  if (browserResumeReconciliationByEnvironment.has(connection.environmentId)) {
    return;
  }
  queueEnvironmentConnectionHealthRecovery(connection, reason, cause);
}

function getThreadDetailSubscriptionKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return scopedThreadKey(scopeThreadRef(environmentId, threadId));
}

function clearThreadDetailSubscriptionEviction(
  entry: ThreadDetailSubscriptionEntry,
): ThreadDetailSubscriptionEntry {
  if (entry.evictionTimeoutId !== null) {
    clearTimeout(entry.evictionTimeoutId);
    entry.evictionTimeoutId = null;
  }
  return entry;
}

function clearThreadDetailSubscriptionReconcile(entry: ThreadDetailSubscriptionEntry): void {
  if (entry.reconcileTimeoutId !== null) {
    clearTimeout(entry.reconcileTimeoutId);
    entry.reconcileTimeoutId = null;
  }
  entry.reconcileRequestedWhileInFlight = false;
}

function clearThreadDetailSubscriptionActiveReconcile(entry: ThreadDetailSubscriptionEntry): void {
  if (entry.activeReconcileIntervalId !== null) {
    clearInterval(entry.activeReconcileIntervalId);
    entry.activeReconcileIntervalId = null;
  }
  entry.lastActiveReconcileTickAt = null;
  entry.lastActiveWakeRefreshAt = null;
  entry.lastActiveDetailReconcileAt = null;
}

function markThreadDetailSequence(entry: ThreadDetailSubscriptionEntry, sequence: number): void {
  entry.latestDetailSequence =
    entry.latestDetailSequence === null ? sequence : Math.max(entry.latestDetailSequence, sequence);
}

function resetThreadDetailSequence(entry: ThreadDetailSubscriptionEntry, sequence: number): void {
  entry.latestDetailSequence = sequence;
}

function markThreadDetailVerified(
  entry: ThreadDetailSubscriptionEntry,
  sequence: number,
  fingerprint: OrchestrationThreadDetailFingerprint,
): void {
  resetThreadDetailSequence(entry, sequence);
  entry.verifiedDetailSequence = sequence;
  entry.verifiedDetailFingerprint = fingerprint;
}

function hasThreadDetailSequenceAlreadyBeenSeen(
  entry: ThreadDetailSubscriptionEntry,
  sequence: number,
): boolean {
  return entry.latestDetailSequence !== null && sequence <= entry.latestDetailSequence;
}

function shouldPreserveThreadDetailShellFields(
  environmentId: EnvironmentId,
  sequence: number,
): boolean {
  const currentProjectionVersion = readLastAppliedProjectionVersion(environmentId);
  return currentProjectionVersion !== null && sequence < currentProjectionVersion.sequence;
}

function isSettledOrchestrationStatus(status: string | null | undefined): boolean {
  return status !== undefined && status !== null && status !== "starting" && status !== "running";
}

function hasLocalActiveThreadWork(thread: Thread | undefined): boolean {
  if (!thread) {
    return false;
  }

  return (
    thread.session?.orchestrationStatus === "running" ||
    thread.session?.activeTurnId !== undefined ||
    thread.latestTurn?.state === "running"
  );
}

function isSettlingThreadDetailEvent(event: OrchestrationEvent): boolean {
  return (
    event.type === "thread.session-set" &&
    isSettledOrchestrationStatus(event.payload.session.status)
  );
}

function isSettlingShellThread(thread: OrchestrationThreadShell): boolean {
  const latestTurnState = thread.latestTurn?.state;
  return (
    isSettledOrchestrationStatus(thread.session?.status) ||
    latestTurnState === "completed" ||
    latestTurnState === "interrupted" ||
    latestTurnState === "error"
  );
}

function isNonIdleThreadDetailSubscription(entry: ThreadDetailSubscriptionEntry): boolean {
  const threadRef = scopeThreadRef(entry.environmentId, entry.threadId);
  const state = useStore.getState();
  const sidebarThread = selectSidebarThreadSummaryByRef(state, threadRef);

  // Prefer shell/sidebar state first because it carries the coarse thread
  // readiness flags used throughout the UI (pending approvals/input/plan).
  if (sidebarThread) {
    if (
      sidebarThread.hasPendingApprovals ||
      sidebarThread.hasPendingUserInput ||
      sidebarThread.hasActionableProposedPlan
    ) {
      return true;
    }

    const orchestrationStatus = sidebarThread.session?.orchestrationStatus;
    if (
      orchestrationStatus &&
      orchestrationStatus !== "idle" &&
      orchestrationStatus !== "stopped"
    ) {
      return true;
    }

    if (sidebarThread.latestTurn?.state === "running") {
      return true;
    }
  }

  const thread = selectThreadByRef(state, threadRef);
  if (!thread) {
    return false;
  }

  const orchestrationStatus = thread.session?.orchestrationStatus;
  return (
    Boolean(
      orchestrationStatus && orchestrationStatus !== "idle" && orchestrationStatus !== "stopped",
    ) ||
    thread.latestTurn?.state === "running" ||
    thread.pendingSourceProposedPlan !== undefined
  );
}

function shouldEvictThreadDetailSubscription(entry: ThreadDetailSubscriptionEntry): boolean {
  return entry.refCount === 0 && !isNonIdleThreadDetailSubscription(entry);
}

function requestThreadDetailReconcile(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  reason: string,
): void {
  const entry = threadDetailSubscriptions.get(
    getThreadDetailSubscriptionKey(environmentId, threadId),
  );
  if (!entry) {
    return;
  }
  scheduleThreadDetailReconcile(entry, reason);
}

// Forces every actively-retained thread detail subscription in the
// environment to re-fetch. Used after a browser-resume path so the open
// chat catches up even when projection replay had no events for it (the
// "navigate away and back" workaround the user otherwise has to do).
function refreshActiveThreadDetailsForEnvironment(
  environmentId: EnvironmentId,
  reason: string,
): void {
  let iterated = 0;
  let reconciled = 0;
  for (const entry of threadDetailSubscriptions.values()) {
    if (entry.environmentId !== environmentId) {
      continue;
    }
    iterated += 1;
    const shouldReconcile = entry.activeRefCount > 0;
    recordResumeDiagnostic("thread-detail-refresh-entry", {
      reason,
      env: environmentId,
      data: {
        threadId: entry.threadId,
        refCount: entry.refCount,
        activeRefCount: entry.activeRefCount,
        reconciled: shouldReconcile,
      },
    });
    if (!shouldReconcile) {
      continue;
    }
    reconciled += 1;
    requestThreadDetailReconcile(entry.environmentId, entry.threadId, reason);
  }
  recordResumeDiagnostic("thread-detail-refresh", {
    reason,
    env: environmentId,
    data: {
      iterated,
      reconciled,
    },
  });
}

function getPendingNotificationThreadReconcileRetainBlockReason(
  environmentId: EnvironmentId,
): string | null {
  const connection = readEnvironmentConnection(environmentId);
  if (!connection) {
    return "missing-connection";
  }
  const browserResumeReconciliation = browserResumeReconciliationByEnvironment.get(environmentId);
  if (browserResumeReconciliation?.forceReconnect) {
    return "browser-resume-forced-reconnect-in-flight";
  }
  if (browserResumeReconciliation?.queuedFollowUp?.options.forceReconnect) {
    return "browser-resume-forced-follow-up-pending";
  }
  if (browserResumeReconnectRetryByEnvironment.get(environmentId)?.options.forceReconnect) {
    return "browser-resume-forced-retry-pending";
  }
  if (browserResumeShellBootstrapTimeoutByEnvironment.has(environmentId)) {
    return "browser-resume-shell-bootstrap-timeout";
  }
  if (!connection.client.isHeartbeatFresh()) {
    return "stale-heartbeat";
  }
  return null;
}

function refreshPendingNotificationThreadDetailsForEnvironment(
  environmentId: EnvironmentId,
  reason: string,
): void {
  const now = Date.now();
  hydratePendingNotificationThreadReconciles(now);
  let iterated = 0;
  let reconciled = 0;

  for (const [key, pending] of pendingNotificationThreadReconcileKeys) {
    if (pending.environmentId !== environmentId) {
      continue;
    }

    iterated += 1;
    const entry = threadDetailSubscriptions.get(key);
    const shouldReconcile = entry !== undefined && entry.activeRefCount > 0;
    recordResumeDiagnostic("notification-thread-reconcile-post-reconnect-entry", {
      reason,
      env: environmentId,
      data: {
        threadId: pending.threadId,
        refCount: entry?.refCount ?? 0,
        activeRefCount: entry?.activeRefCount ?? 0,
        pendingAgeMs: now - pending.createdAt,
        reconciled: shouldReconcile,
      },
    });
    if (!entry || !shouldReconcile) {
      continue;
    }

    deletePendingNotificationThreadReconcile(key);
    reconciled += 1;
    scheduleThreadDetailReconcile(entry, reason);
  }

  if (iterated > 0) {
    recordResumeDiagnostic("notification-thread-reconcile-post-reconnect", {
      reason,
      env: environmentId,
      data: {
        iterated,
        reconciled,
        pendingCount: pendingNotificationThreadReconcileKeys.size,
      },
    });
  }
}

function shouldRefreshRetainedThreadDetailSubscription(entry: ThreadDetailSubscriptionEntry) {
  return entry.refCount > 0 || isNonIdleThreadDetailSubscription(entry);
}

function shouldRunActiveThreadDetailSubscriptionTimer(
  entry: ThreadDetailSubscriptionEntry,
): boolean {
  return entry.activeRefCount > 0;
}

function shouldActivelyReconcileThreadDetailSubscription(
  entry: ThreadDetailSubscriptionEntry,
): boolean {
  return entry.activeRefCount > 0 && isNonIdleThreadDetailSubscription(entry);
}

function hasRetainedThreadDetailSubscription(): boolean {
  for (const entry of threadDetailSubscriptions.values()) {
    if (entry.refCount > 0) {
      return true;
    }
  }
  return false;
}

function attachThreadDetailSubscription(entry: ThreadDetailSubscriptionEntry): boolean {
  if (entry.unsubscribeConnectionListener !== null) {
    entry.unsubscribeConnectionListener();
    entry.unsubscribeConnectionListener = null;
  }
  if (entry.unsubscribe !== NOOP) {
    return true;
  }

  const connection = readEnvironmentConnection(entry.environmentId);
  if (!connection) {
    return false;
  }

  entry.unsubscribe = connection.client.orchestration.subscribeThread(
    { threadId: entry.threadId },
    (item) => {
      if (item.kind === "snapshot") {
        const shouldResetDetailSequence = entry.resetDetailSequenceOnNextSnapshot;
        entry.resetDetailSequenceOnNextSnapshot = false;
        if (
          !shouldResetDetailSequence &&
          entry.latestDetailSequence !== null &&
          item.snapshot.snapshotSequence < entry.latestDetailSequence
        ) {
          return;
        }
        const fingerprint = computeOrchestrationThreadDetailFingerprint(item.snapshot);
        if (shouldResetDetailSequence) {
          resetThreadDetailSequence(entry, item.snapshot.snapshotSequence);
        } else {
          markThreadDetailSequence(entry, item.snapshot.snapshotSequence);
        }
        markThreadDetailVerified(entry, item.snapshot.snapshotSequence, fingerprint);
        useStore
          .getState()
          .mergeServerThreadDetailTailSnapshot(item.snapshot.thread, entry.environmentId, {
            pageInfo: item.snapshot.pageInfo,
            preserveShellFields: shouldPreserveThreadDetailShellFields(
              entry.environmentId,
              item.snapshot.snapshotSequence,
            ),
          });
        scheduleEnvironmentStartupCacheWrite(entry.environmentId, [entry.threadId]);
        reconcileThreadDetailSubscriptionEvictionState(entry);
        return;
      }
      if (hasThreadDetailSequenceAlreadyBeenSeen(entry, item.event.sequence)) {
        return;
      }
      markThreadDetailSequence(entry, item.event.sequence);
      applyEnvironmentThreadDetailEvent(item.event, entry.environmentId);
      reconcileThreadDetailSubscriptionEvictionState(entry);
    },
  );
  return true;
}

function scheduleThreadDetailReconcile(entry: ThreadDetailSubscriptionEntry, reason: string): void {
  if (entry.activeRefCount <= 0) {
    entry.reconcileOnNextActiveRetain = true;
    return;
  }

  const now = Date.now();
  if (
    reason === "projection-behind" &&
    entry.lastActiveDetailReconcileAt !== null &&
    now - entry.lastActiveDetailReconcileAt < THREAD_DETAIL_ACTIVE_RECONCILE_COOLDOWN_MS
  ) {
    return;
  }
  entry.lastActiveDetailReconcileAt = now;
  if (entry.reconcileTimeoutId !== null) {
    clearTimeout(entry.reconcileTimeoutId);
  }
  entry.reconcileTimeoutId = setTimeout(() => {
    entry.reconcileTimeoutId = null;
    const current = threadDetailSubscriptions.get(
      getThreadDetailSubscriptionKey(entry.environmentId, entry.threadId),
    );
    if (!current) {
      return;
    }
    void runThreadDetailReconcile(current, reason);
  }, THREAD_DETAIL_REFRESH_AFTER_SHELL_ADVANCE_MS);
}

async function runThreadDetailReconcile(
  entry: ThreadDetailSubscriptionEntry,
  reason: string,
): Promise<void> {
  if (entry.reconcileInFlight) {
    entry.reconcileRequestedWhileInFlight = true;
    return;
  }

  const connection = readEnvironmentConnection(entry.environmentId);
  if (!connection) {
    return;
  }
  if (!connection.client.isHeartbeatFresh()) {
    queueEnvironmentConnectionHealthRecoveryIfIdle(connection, `thread-detail-reconcile:${reason}`);
    return;
  }

  entry.reconcileInFlight = true;
  try {
    const result = await connection.client.orchestration.reconcileThreadDetail({
      threadId: entry.threadId,
      clientSequence: entry.latestDetailSequence,
      verifiedSequence: entry.verifiedDetailSequence,
      verifiedFingerprint: entry.verifiedDetailFingerprint,
    });
    const current = threadDetailSubscriptions.get(
      getThreadDetailSubscriptionKey(entry.environmentId, entry.threadId),
    );
    if (current !== entry || readEnvironmentConnection(entry.environmentId) !== connection) {
      return;
    }
    applyThreadDetailReconcileResult(entry, result);
  } catch (error) {
    console.warn("Thread detail reconcile failed", {
      environmentId: entry.environmentId,
      threadId: entry.threadId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    const current = threadDetailSubscriptions.get(
      getThreadDetailSubscriptionKey(entry.environmentId, entry.threadId),
    );
    if (current === entry) {
      entry.reconcileInFlight = false;
      if (entry.reconcileRequestedWhileInFlight) {
        entry.reconcileRequestedWhileInFlight = false;
        scheduleThreadDetailReconcile(entry, "coalesced");
      }
    }
  }
}

function applyThreadDetailReconcileResult(
  entry: ThreadDetailSubscriptionEntry,
  result: Awaited<
    ReturnType<EnvironmentConnection["client"]["orchestration"]["reconcileThreadDetail"]>
  >,
): void {
  switch (result.kind) {
    case "current":
      markThreadDetailVerified(entry, result.serverSequence, result.serverFingerprint);
      return;
    case "events":
      for (const event of result.events) {
        if (!hasThreadDetailSequenceAlreadyBeenSeen(entry, event.sequence)) {
          markThreadDetailSequence(entry, event.sequence);
          applyEnvironmentThreadDetailEvent(event, entry.environmentId, {
            suppressReconcile: true,
          });
        }
      }
      markThreadDetailVerified(entry, result.serverSequence, result.serverFingerprint);
      scheduleEnvironmentStartupCacheWrite(entry.environmentId, [entry.threadId]);
      reconcileThreadDetailSubscriptionEvictionState(entry);
      return;
    case "snapshot":
      markThreadDetailVerified(entry, result.serverSequence, result.serverFingerprint);
      useStore
        .getState()
        .mergeServerThreadDetailTailSnapshot(result.snapshot.thread, entry.environmentId, {
          pageInfo: result.snapshot.pageInfo,
          preserveShellFields: shouldPreserveThreadDetailShellFields(
            entry.environmentId,
            result.snapshot.snapshotSequence,
          ),
        });
      scheduleEnvironmentStartupCacheWrite(entry.environmentId, [entry.threadId]);
      reconcileThreadDetailSubscriptionEvictionState(entry);
      return;
  }
}

function scheduleThreadDetailReconcileIfBehind(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  sequence: number,
): void {
  const entry = threadDetailSubscriptions.get(
    getThreadDetailSubscriptionKey(environmentId, threadId),
  );
  if (!entry || !shouldRefreshRetainedThreadDetailSubscription(entry)) {
    return;
  }

  if (
    entry.latestDetailSequence !== null &&
    entry.latestDetailSequence >= sequence &&
    entry.verifiedDetailSequence === entry.latestDetailSequence
  ) {
    return;
  }

  scheduleThreadDetailReconcile(entry, "projection-behind");
}

function scheduleThreadDetailReconcileToCurrentProjectionIfBehind(
  entry: ThreadDetailSubscriptionEntry,
): void {
  const currentProjectionSequence = readLastAppliedProjectionVersion(entry.environmentId)?.sequence;
  if (currentProjectionSequence === undefined) {
    return;
  }
  scheduleThreadDetailReconcileIfBehind(
    entry.environmentId,
    entry.threadId,
    currentProjectionSequence,
  );
}

function reconcileActiveThreadDetailSubscription(entry: ThreadDetailSubscriptionEntry): void {
  const connection = readEnvironmentConnection(entry.environmentId);
  if (connection) {
    if (connection.client.isHeartbeatFresh()) {
      queueEnvironmentActiveThreadProjectionReconciliation(connection);
    } else {
      queueEnvironmentConnectionHealthRecoveryIfIdle(
        connection,
        "active-thread-detail-stale-heartbeat",
      );
    }
  }
  scheduleThreadDetailReconcileToCurrentProjectionIfBehind(entry);
}

function reconcileActiveThreadDetailWakeDrift(
  entry: ThreadDetailSubscriptionEntry,
  now: number,
): boolean {
  const previousTickAt = entry.lastActiveReconcileTickAt;
  entry.lastActiveReconcileTickAt = now;
  if (previousTickAt === null) {
    return false;
  }

  const elapsedMs = now - previousTickAt;
  if (
    elapsedMs <=
    THREAD_DETAIL_ACTIVE_RECONCILE_INTERVAL_MS + THREAD_DETAIL_ACTIVE_RECONCILE_WAKE_DRIFT_MS
  ) {
    return false;
  }

  if (
    entry.lastActiveWakeRefreshAt !== null &&
    now - entry.lastActiveWakeRefreshAt < THREAD_DETAIL_ACTIVE_WAKE_REFRESH_COOLDOWN_MS
  ) {
    return false;
  }

  entry.lastActiveWakeRefreshAt = now;
  requestThreadDetailReconcile(entry.environmentId, entry.threadId, "active-wake-drift");
  return true;
}

function reconcileActiveNonIdleThreadDetail(
  entry: ThreadDetailSubscriptionEntry,
  now: number,
): void {
  if (!shouldActivelyReconcileThreadDetailSubscription(entry)) {
    return;
  }
  const lastReconcileAt = entry.lastActiveDetailReconcileAt ?? entry.lastAccessedAt;
  const requiredElapsed =
    entry.lastActiveDetailReconcileAt === null
      ? THREAD_DETAIL_ACTIVE_RECONCILE_FIRST_PING_MS
      : THREAD_DETAIL_ACTIVE_RECONCILE_COOLDOWN_MS;
  if (now - lastReconcileAt < requiredElapsed) {
    return;
  }
  entry.lastActiveDetailReconcileAt = now;
  scheduleThreadDetailReconcile(entry, "active-non-idle");
}

function reconcileThreadDetailSubscriptionActiveReconcileState(
  entry: ThreadDetailSubscriptionEntry,
): void {
  if (!shouldRunActiveThreadDetailSubscriptionTimer(entry)) {
    clearThreadDetailSubscriptionActiveReconcile(entry);
    return;
  }

  if (entry.activeReconcileIntervalId !== null) {
    return;
  }

  entry.lastActiveReconcileTickAt = Date.now();
  entry.activeReconcileIntervalId = setInterval(() => {
    const currentEntry = threadDetailSubscriptions.get(
      getThreadDetailSubscriptionKey(entry.environmentId, entry.threadId),
    );
    if (!currentEntry) {
      return;
    }
    if (!shouldRunActiveThreadDetailSubscriptionTimer(currentEntry)) {
      clearThreadDetailSubscriptionActiveReconcile(currentEntry);
      return;
    }
    const now = Date.now();
    reconcileActiveThreadDetailWakeDrift(currentEntry, now);
    if (shouldActivelyReconcileThreadDetailSubscription(currentEntry)) {
      reconcileActiveThreadDetailSubscription(currentEntry);
      reconcileActiveNonIdleThreadDetail(currentEntry, now);
    }
  }, THREAD_DETAIL_ACTIVE_RECONCILE_INTERVAL_MS);
}

function watchThreadDetailSubscriptionConnection(entry: ThreadDetailSubscriptionEntry): void {
  if (entry.unsubscribeConnectionListener !== null) {
    return;
  }

  entry.unsubscribeConnectionListener = subscribeEnvironmentConnections(() => {
    if (attachThreadDetailSubscription(entry)) {
      entry.lastAccessedAt = Date.now();
    }
  });
  attachThreadDetailSubscription(entry);
}

function disposeThreadDetailSubscriptionByKey(key: string): boolean {
  const entry = threadDetailSubscriptions.get(key);
  if (!entry) {
    return false;
  }

  clearThreadDetailSubscriptionReconcile(entry);
  clearThreadDetailSubscriptionEviction(entry);
  clearThreadDetailSubscriptionActiveReconcile(entry);
  entry.unsubscribeConnectionListener?.();
  entry.unsubscribeConnectionListener = null;
  threadDetailSubscriptions.delete(key);
  entry.unsubscribe();
  entry.unsubscribe = NOOP;
  return true;
}

function disposeThreadDetailSubscriptionsForEnvironment(environmentId: EnvironmentId): void {
  for (const [key, entry] of threadDetailSubscriptions) {
    if (entry.environmentId === environmentId) {
      disposeThreadDetailSubscriptionByKey(key);
    }
  }
}

function detachThreadDetailSubscriptionsForEnvironment(environmentId: EnvironmentId): void {
  for (const entry of threadDetailSubscriptions.values()) {
    if (entry.environmentId !== environmentId) {
      continue;
    }
    entry.unsubscribe();
    entry.unsubscribe = NOOP;
    watchThreadDetailSubscriptionConnection(entry);
  }
}

function attachThreadDetailSubscriptionsForEnvironment(environmentId: EnvironmentId): void {
  for (const entry of threadDetailSubscriptions.values()) {
    if (entry.environmentId === environmentId) {
      attachThreadDetailSubscription(entry);
    }
  }
}

function reconcileThreadDetailSubscriptionsForEnvironment(
  environmentId: EnvironmentId,
  threadIds: ReadonlyArray<ThreadId>,
): void {
  const activeThreadIds = new Set(threadIds);
  for (const [key, entry] of threadDetailSubscriptions) {
    if (entry.environmentId === environmentId && !activeThreadIds.has(entry.threadId)) {
      disposeThreadDetailSubscriptionByKey(key);
    }
  }
}

function scheduleThreadDetailSubscriptionEviction(entry: ThreadDetailSubscriptionEntry): void {
  clearThreadDetailSubscriptionEviction(entry);
  if (!shouldEvictThreadDetailSubscription(entry)) {
    return;
  }

  entry.evictionTimeoutId = setTimeout(() => {
    const currentEntry = threadDetailSubscriptions.get(
      getThreadDetailSubscriptionKey(entry.environmentId, entry.threadId),
    );
    if (!currentEntry) {
      return;
    }

    currentEntry.evictionTimeoutId = null;
    if (!shouldEvictThreadDetailSubscription(currentEntry)) {
      return;
    }
    disposeThreadDetailSubscriptionByKey(
      getThreadDetailSubscriptionKey(entry.environmentId, entry.threadId),
    );
  }, THREAD_DETAIL_SUBSCRIPTION_IDLE_EVICTION_MS);
}

function evictIdleThreadDetailSubscriptionsToCapacity(): void {
  if (threadDetailSubscriptions.size <= MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS) {
    return;
  }

  const idleEntries = [...threadDetailSubscriptions.entries()]
    .filter(([, entry]) => shouldEvictThreadDetailSubscription(entry))
    .toSorted(([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt);

  for (const [key] of idleEntries) {
    if (threadDetailSubscriptions.size <= MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS) {
      return;
    }
    disposeThreadDetailSubscriptionByKey(key);
  }
}

function reconcileThreadDetailSubscriptionEvictionState(
  entry: ThreadDetailSubscriptionEntry,
): void {
  reconcileThreadDetailSubscriptionActiveReconcileState(entry);
  clearThreadDetailSubscriptionEviction(entry);
  if (!shouldEvictThreadDetailSubscription(entry)) {
    return;
  }

  scheduleThreadDetailSubscriptionEviction(entry);
}

function reconcileThreadDetailSubscriptionEvictionForThread(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): void {
  const entry = threadDetailSubscriptions.get(
    getThreadDetailSubscriptionKey(environmentId, threadId),
  );
  if (!entry) {
    return;
  }

  reconcileThreadDetailSubscriptionEvictionState(entry);
}

function reconcileThreadDetailSubscriptionEvictionForEnvironment(
  environmentId: EnvironmentId,
): void {
  for (const entry of threadDetailSubscriptions.values()) {
    if (entry.environmentId === environmentId) {
      reconcileThreadDetailSubscriptionEvictionState(entry);
    }
  }
  evictIdleThreadDetailSubscriptionsToCapacity();
}

function retainThreadDetailSubscriptionInternal(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  options: { readonly active: boolean },
): () => void {
  const key = getThreadDetailSubscriptionKey(environmentId, threadId);
  const existing = threadDetailSubscriptions.get(key);
  if (existing) {
    const wasActive = existing.activeRefCount > 0;
    clearThreadDetailSubscriptionEviction(existing);
    existing.refCount += 1;
    if (options.active) {
      existing.activeRefCount += 1;
    }
    existing.lastAccessedAt = Date.now();
    if (!attachThreadDetailSubscription(existing)) {
      watchThreadDetailSubscriptionConnection(existing);
    }
    if (options.active) {
      if (consumePendingNotificationThreadReconcile(environmentId, threadId)) {
        existing.reconcileOnNextActiveRetain = true;
        scheduleThreadDetailReconcile(existing, "active-retain");
        existing.reconcileOnNextActiveRetain = false;
      } else if (
        !wasActive &&
        (existing.latestDetailSequence !== null || existing.reconcileOnNextActiveRetain)
      ) {
        existing.reconcileOnNextActiveRetain = false;
        scheduleThreadDetailReconcile(existing, "active-retain");
      } else {
        scheduleThreadDetailReconcileToCurrentProjectionIfBehind(existing);
      }
    }
    reconcileThreadDetailSubscriptionEvictionState(existing);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      existing.refCount = Math.max(0, existing.refCount - 1);
      if (options.active) {
        existing.activeRefCount = Math.max(0, existing.activeRefCount - 1);
      }
      existing.lastAccessedAt = Date.now();
      reconcileThreadDetailSubscriptionEvictionState(existing);
      evictIdleThreadDetailSubscriptionsToCapacity();
    };
  }

  const entry: ThreadDetailSubscriptionEntry = {
    environmentId,
    threadId,
    unsubscribe: NOOP,
    unsubscribeConnectionListener: null,
    refCount: 1,
    activeRefCount: options.active ? 1 : 0,
    latestDetailSequence: null,
    verifiedDetailSequence: null,
    verifiedDetailFingerprint: null,
    resetDetailSequenceOnNextSnapshot: false,
    reconcileOnNextActiveRetain: false,
    reconcileTimeoutId: null,
    reconcileInFlight: false,
    reconcileRequestedWhileInFlight: false,
    activeReconcileIntervalId: null,
    lastActiveReconcileTickAt: null,
    lastActiveWakeRefreshAt: null,
    lastActiveDetailReconcileAt: null,
    lastAccessedAt: Date.now(),
    evictionTimeoutId: null,
  };
  threadDetailSubscriptions.set(key, entry);
  if (!attachThreadDetailSubscription(entry)) {
    watchThreadDetailSubscriptionConnection(entry);
  }
  if (options.active && consumePendingNotificationThreadReconcile(environmentId, threadId)) {
    entry.reconcileOnNextActiveRetain = true;
    scheduleThreadDetailReconcile(entry, "active-retain");
    entry.reconcileOnNextActiveRetain = false;
  }
  reconcileThreadDetailSubscriptionEvictionState(entry);
  evictIdleThreadDetailSubscriptionsToCapacity();

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    entry.refCount = Math.max(0, entry.refCount - 1);
    if (options.active) {
      entry.activeRefCount = Math.max(0, entry.activeRefCount - 1);
    }
    entry.lastAccessedAt = Date.now();
    reconcileThreadDetailSubscriptionEvictionState(entry);
    evictIdleThreadDetailSubscriptionsToCapacity();
  };
}

export function retainThreadDetailSubscription(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): () => void {
  return retainThreadDetailSubscriptionInternal(environmentId, threadId, { active: false });
}

export function retainActiveThreadDetailSubscription(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): () => void {
  return retainThreadDetailSubscriptionInternal(environmentId, threadId, { active: true });
}

function emitEnvironmentConnectionRegistryChange() {
  for (const listener of environmentConnectionListeners) {
    listener();
  }
}

function getRuntimeErrorFields(error: unknown) {
  return {
    lastError: error instanceof Error ? error.message : String(error),
    lastErrorAt: new Date().toISOString(),
  } as const;
}

function isoNow(): string {
  return new Date().toISOString();
}

function readSshHttpErrorStatus(error: unknown): number | null {
  if (!(error instanceof Error)) {
    return null;
  }

  const match = SSH_HTTP_STATUS_RE.exec(error.message);
  if (!match) {
    return null;
  }

  const parsed = Number.parseInt(match[1] ?? "", 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function isSshHttpAuthError(error: unknown, status: number): boolean {
  return readSshHttpErrorStatus(error) === status;
}

function isDesktopSshTargetEqual(
  left: DesktopSshEnvironmentTarget | undefined,
  right: DesktopSshEnvironmentTarget | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }

  return (
    left.alias === right.alias &&
    left.hostname === right.hostname &&
    left.username === right.username &&
    left.port === right.port
  );
}

function findSavedEnvironmentRecordByDesktopSshTarget(
  target: DesktopSshEnvironmentTarget | undefined,
): SavedEnvironmentRecord | null {
  if (!target) {
    return null;
  }

  return (
    listSavedEnvironmentRecords().find((record) =>
      isDesktopSshTargetEqual(record.desktopSsh, target),
    ) ?? null
  );
}

function buildSavedEnvironmentRegistryById(
  records: ReadonlyArray<SavedEnvironmentRecord>,
): Record<EnvironmentId, SavedEnvironmentRecord> {
  return Object.fromEntries(records.map((record) => [record.environmentId, record])) as Record<
    EnvironmentId,
    SavedEnvironmentRecord
  >;
}

type SavedEnvironmentRegistrySnapshot = ReadonlyMap<EnvironmentId, SavedEnvironmentRecord | null>;

function snapshotSavedEnvironmentRegistry(
  environmentIds: ReadonlyArray<EnvironmentId>,
): SavedEnvironmentRegistrySnapshot {
  return new Map(
    environmentIds.map((environmentId) => [
      environmentId,
      getSavedEnvironmentRecord(environmentId) ?? null,
    ]),
  );
}

async function persistSavedEnvironmentRegistryRollback(
  snapshot: SavedEnvironmentRegistrySnapshot,
): Promise<void> {
  const byId = buildSavedEnvironmentRegistryById(listSavedEnvironmentRecords());
  for (const [environmentId, record] of snapshot) {
    if (record) {
      byId[environmentId] = record;
      continue;
    }
    delete byId[environmentId];
  }
  const records = Object.values(byId);
  await ensureLocalApi().persistence.setSavedEnvironmentRegistry(
    records.map((entry) => toPersistedSavedEnvironmentRecord(entry)),
  );
  useSavedEnvironmentRegistryStore.setState({
    byId,
  });
}

async function resolveDesktopSshEnvironmentBootstrap(
  target: DesktopSshEnvironmentTarget,
  options?: { readonly issuePairingToken?: boolean },
): Promise<DesktopSshEnvironmentBootstrap> {
  const desktopBridge = window.desktopBridge;
  if (!desktopBridge) {
    throw new Error("SSH launch is only available in the desktop app.");
  }

  return await desktopBridge.ensureSshEnvironment(target, options);
}

function getDesktopSshBridge() {
  const desktopBridge = window.desktopBridge;
  if (!desktopBridge) {
    throw new Error("SSH launch is only available in the desktop app.");
  }
  return desktopBridge;
}

async function fetchDesktopSshEnvironmentDescriptor(httpBaseUrl: string) {
  return await getDesktopSshBridge().fetchSshEnvironmentDescriptor(httpBaseUrl);
}

async function bootstrapDesktopSshBearerSession(httpBaseUrl: string, credential: string) {
  return await getDesktopSshBridge().bootstrapSshBearerSession(httpBaseUrl, credential);
}

async function fetchDesktopSshSessionState(httpBaseUrl: string, bearerToken: string) {
  return await getDesktopSshBridge().fetchSshSessionState(httpBaseUrl, bearerToken);
}

async function resolveDesktopSshWebSocketConnectionUrl(
  wsBaseUrl: string,
  httpBaseUrl: string,
  bearerToken: string,
) {
  const issued = await getDesktopSshBridge().issueSshWebSocketToken(httpBaseUrl, bearerToken);
  const url = new URL(wsBaseUrl, window.location.origin);
  url.searchParams.set("wsToken", issued.token);
  return url.toString();
}

async function prepareSavedEnvironmentRecordForConnection(
  record: SavedEnvironmentRecord,
  options?: { readonly issuePairingToken?: boolean },
): Promise<{
  readonly record: SavedEnvironmentRecord;
  readonly pairingToken: string | null;
  readonly remotePort: number | null;
  readonly remoteServerKind: "external" | "managed" | null;
}> {
  if (!record.desktopSsh) {
    return {
      record,
      pairingToken: null,
      remotePort: null,
      remoteServerKind: null,
    };
  }

  const bootstrap = await resolveDesktopSshEnvironmentBootstrap(record.desktopSsh, options);
  const nextRecord: SavedEnvironmentRecord = {
    ...record,
    httpBaseUrl: bootstrap.httpBaseUrl,
    wsBaseUrl: bootstrap.wsBaseUrl,
    desktopSsh: bootstrap.target,
  };

  if (
    nextRecord.httpBaseUrl !== record.httpBaseUrl ||
    nextRecord.wsBaseUrl !== record.wsBaseUrl ||
    !isDesktopSshTargetEqual(nextRecord.desktopSsh, record.desktopSsh)
  ) {
    await persistSavedEnvironmentRecord(nextRecord);
    useSavedEnvironmentRegistryStore.getState().upsert(nextRecord);
  }

  return {
    record: nextRecord,
    pairingToken: bootstrap.pairingToken,
    remotePort: bootstrap.remotePort ?? null,
    remoteServerKind: bootstrap.remoteServerKind ?? null,
  };
}

async function issueDesktopSshBearerSession(record: SavedEnvironmentRecord): Promise<{
  readonly record: SavedEnvironmentRecord;
  readonly bearerToken: string;
  readonly role: AuthSessionRole | null;
}> {
  const registrySnapshot = snapshotSavedEnvironmentRegistry([record.environmentId]);
  const prepared = await prepareSavedEnvironmentRecordForConnection(record, {
    issuePairingToken: true,
  });
  if (!prepared.pairingToken) {
    await persistSavedEnvironmentRegistryRollback(registrySnapshot);
    throw new Error("Desktop SSH launch did not return a pairing token.");
  }

  const bearerSession = await bootstrapDesktopSshBearerSession(
    prepared.record.httpBaseUrl,
    prepared.pairingToken,
  ).catch(async (error) => {
    await persistSavedEnvironmentRegistryRollback(registrySnapshot);
    const detail = [
      `local ${prepared.record.httpBaseUrl}`,
      `remote port ${prepared.remotePort ?? "unknown"}`,
      prepared.remoteServerKind ? `remote server ${prepared.remoteServerKind}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} (${detail})`);
  });
  const didPersistBearerToken = await writeSavedEnvironmentBearerToken(
    prepared.record.environmentId,
    bearerSession.sessionToken,
  );
  if (!didPersistBearerToken) {
    await persistSavedEnvironmentRegistryRollback(registrySnapshot);
    throw new Error("Unable to persist saved environment credentials.");
  }

  return {
    record: prepared.record,
    bearerToken: bearerSession.sessionToken,
    role: bearerSession.role ?? null,
  };
}

function setRuntimeConnecting(environmentId: EnvironmentId) {
  useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
    connectionState: "connecting",
    lastError: null,
    lastErrorAt: null,
  });
}

function setRuntimeConnected(environmentId: EnvironmentId) {
  const connectedAt = isoNow();
  useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
    connectionState: "connected",
    authState: "authenticated",
    connectedAt,
    disconnectedAt: null,
    lastError: null,
    lastErrorAt: null,
  });
  useSavedEnvironmentRegistryStore.getState().markConnected(environmentId, connectedAt);
}

function setRuntimeDisconnected(environmentId: EnvironmentId, reason?: string | null) {
  useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
    connectionState: "disconnected",
    disconnectedAt: isoNow(),
    ...(reason && reason.trim().length > 0
      ? {
          lastError: reason,
          lastErrorAt: isoNow(),
        }
      : {}),
  });
}

function setRuntimeError(environmentId: EnvironmentId, error: unknown) {
  useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
    connectionState: "error",
    ...getRuntimeErrorFields(error),
  });
}

function coalesceOrchestrationUiEvents(
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationEvent[] {
  if (events.length < 2) {
    return [...events];
  }

  const coalesced: OrchestrationEvent[] = [];
  for (const event of events) {
    const previous = coalesced.at(-1);
    if (
      previous?.type === "thread.message-sent" &&
      event.type === "thread.message-sent" &&
      previous.payload.threadId === event.payload.threadId &&
      previous.payload.messageId === event.payload.messageId
    ) {
      coalesced[coalesced.length - 1] = {
        ...event,
        payload: {
          ...event.payload,
          attachments: event.payload.attachments ?? previous.payload.attachments,
          createdAt: previous.payload.createdAt,
          text:
            !event.payload.streaming && event.payload.text.length > 0
              ? event.payload.text
              : previous.payload.text + event.payload.text,
        },
      };
      continue;
    }

    coalesced.push(event);
  }

  return coalesced;
}

function syncProjectUiFromStore() {
  const projects = selectProjectsAcrossEnvironments(useStore.getState());
  const clientSettings = getClientSettings();
  useUiStateStore.getState().syncProjects(
    projects.map((project) => ({
      key: derivePhysicalProjectKey(project),
      logicalKey: deriveLogicalProjectKeyFromSettings(project, clientSettings),
      cwd: project.cwd,
    })),
  );
}

function syncThreadUiFromStore() {
  const threads = selectThreadsAcrossEnvironments(useStore.getState());
  useUiStateStore.getState().syncThreads(
    threads.map((thread) => ({
      key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      seedVisitedAt: thread.updatedAt ?? thread.createdAt,
    })),
  );
  markPromotedDraftThreadsByRef(
    threads.map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
  );
}

function reconcileSnapshotDerivedState() {
  syncProjectUiFromStore();
  syncThreadUiFromStore();

  const threads = selectThreadsAcrossEnvironments(useStore.getState());
  const activeThreadKeys = collectActiveTerminalThreadIds({
    snapshotThreads: threads.map((thread) => ({
      key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      deletedAt: null,
      archivedAt: thread.archivedAt,
    })),
    draftThreadKeys: useComposerDraftStore.getState().listDraftThreadKeys(),
  });
  useTerminalStateStore.getState().removeOrphanedTerminalStates(activeThreadKeys);
}

function hydrateEnvironmentFromStartupCache(environmentId: EnvironmentId): void {
  const cachedState = readCachedEnvironmentState(environmentId);
  if (!cachedState) {
    return;
  }

  const previousEnvironmentState = useStore.getState().environmentStateById[environmentId];
  useStore.getState().hydrateCachedEnvironmentState(environmentId, cachedState);
  if (useStore.getState().environmentStateById[environmentId] === previousEnvironmentState) {
    return;
  }

  reconcileSnapshotDerivedState();
}

function scheduleEnvironmentStartupCacheWrite(
  environmentId: EnvironmentId,
  preferredThreadIds: readonly ThreadId[] = [],
): void {
  const environmentState = useStore.getState().environmentStateById[environmentId];
  if (!environmentState) {
    return;
  }

  scheduleCachedEnvironmentStateWrite(environmentId, environmentState, {
    preferredThreadIds,
  });
}

function collectThreadIdsFromEvents(events: ReadonlyArray<OrchestrationEvent>): ThreadId[] {
  const threadIds = new Set<ThreadId>();
  for (const event of events) {
    const threadId = getOrchestrationEventThreadId(event);
    if (threadId !== null) {
      threadIds.add(threadId);
    }
  }
  return [...threadIds];
}

export function shouldApplyTerminalEvent(input: {
  serverThreadArchivedAt: string | null | undefined;
  hasDraftThread: boolean;
}): boolean {
  if (input.serverThreadArchivedAt !== undefined) {
    return input.serverThreadArchivedAt === null;
  }

  return input.hasDraftThread;
}

function applyRecoveredEventBatch(
  events: ReadonlyArray<OrchestrationEvent>,
  environmentId: EnvironmentId,
  options: RecoveredEventBatchOptions = {},
) {
  if (events.length === 0) {
    return;
  }

  const batchEffects = deriveOrchestrationBatchEffects(events);
  const uiEvents = coalesceOrchestrationUiEvents(events);
  const needsProjectUiSync = events.some(
    (event) =>
      event.type === "project.created" ||
      event.type === "project.meta-updated" ||
      event.type === "project.deleted",
  );

  if (batchEffects.needsProviderInvalidation) {
    needsProviderInvalidation = true;
    void activeService?.queryInvalidationThrottler.maybeExecute();
  }

  useStore.getState().applyOrchestrationEvents(uiEvents, environmentId, {
    preserveShellFields: options.preserveShellFields ?? false,
    syncSidebarSummaries: options.syncSidebarSummaries ?? false,
  });
  if (needsProjectUiSync) {
    const projects = selectProjectsAcrossEnvironments(useStore.getState());
    const clientSettings = getClientSettings();
    useUiStateStore.getState().syncProjects(
      projects.map((project) => ({
        key: derivePhysicalProjectKey(project),
        logicalKey: deriveLogicalProjectKeyFromSettings(project, clientSettings),
        cwd: project.cwd,
      })),
    );
  }

  const needsThreadUiSync = events.some(
    (event) => event.type === "thread.created" || event.type === "thread.deleted",
  );
  if (needsThreadUiSync) {
    const threads = selectThreadsAcrossEnvironments(useStore.getState());
    useUiStateStore.getState().syncThreads(
      threads.map((thread) => ({
        key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        seedVisitedAt: thread.updatedAt ?? thread.createdAt,
      })),
    );
  }

  const draftStore = useComposerDraftStore.getState();
  for (const threadId of batchEffects.promoteDraftThreadIds) {
    markPromotedDraftThreadByRef(scopeThreadRef(environmentId, threadId));
  }
  for (const threadId of batchEffects.clearDeletedThreadIds) {
    const threadRef = scopeThreadRef(environmentId, threadId);
    disposeThreadDetailSubscriptionByKey(scopedThreadKey(threadRef));
    draftStore.clearDraftThread(threadRef);
    useUiStateStore.getState().clearThreadUi(scopedThreadKey(threadRef));
  }
  for (const event of events) {
    if (event.type === "project.deleted") {
      draftStore.clearProjectDraftThreadId(scopeProjectRef(environmentId, event.payload.projectId));
    }
  }
  for (const threadId of batchEffects.removeTerminalStateThreadIds) {
    useTerminalStateStore.getState().removeTerminalState(scopeThreadRef(environmentId, threadId));
  }

  reconcileThreadDetailSubscriptionEvictionForEnvironment(environmentId);
  scheduleEnvironmentStartupCacheWrite(environmentId, collectThreadIdsFromEvents(events));
}

export function applyEnvironmentThreadDetailEvent(
  event: OrchestrationEvent,
  environmentId: EnvironmentId,
  options?: { readonly suppressReconcile?: boolean },
) {
  const threadId = getOrchestrationEventThreadId(event);
  const previousThread =
    threadId === null
      ? undefined
      : selectThreadByRef(useStore.getState(), scopeThreadRef(environmentId, threadId));

  applyRecoveredEventBatch([event], environmentId, {
    preserveShellFields: shouldPreserveThreadDetailShellFields(environmentId, event.sequence),
  });

  if (
    !options?.suppressReconcile &&
    threadId !== null &&
    hasLocalActiveThreadWork(previousThread) &&
    isSettlingThreadDetailEvent(event)
  ) {
    requestThreadDetailReconcile(environmentId, threadId, "detail-settled");
  }
}

function applyShellEvent(event: OrchestrationShellStreamEvent, environmentId: EnvironmentId) {
  const currentProjectionVersion = readLastAppliedProjectionVersion(environmentId);
  if (projectionRecoveryByEnvironment.has(environmentId)) {
    noteProjectionRecoveryObservedSequence(environmentId, event.sequence);
    return;
  }

  const projectionDecision = classifyProjectionEvent({
    current: currentProjectionVersion,
    sequence: event.sequence,
  });
  if (projectionDecision === "stale") {
    return;
  }
  if (projectionDecision === "gap") {
    queueProjectionRecovery(environmentId, event.sequence);
    return;
  }

  const threadId =
    event.kind === "thread-upserted"
      ? event.thread.id
      : event.kind === "thread-removed"
        ? event.threadId
        : null;
  const threadRef = threadId ? scopeThreadRef(environmentId, threadId) : null;
  const previousThread = threadRef ? selectThreadByRef(useStore.getState(), threadRef) : undefined;

  useStore.getState().applyShellEvent(event, environmentId);
  markAppliedProjectionEvent(environmentId, event.sequence);
  scheduleEnvironmentStartupCacheWrite(environmentId, threadId ? [threadId] : []);

  switch (event.kind) {
    case "project-upserted":
    case "project-removed":
      syncProjectUiFromStore();
      return;
    case "thread-upserted":
      syncThreadUiFromStore();
      scheduleThreadDetailReconcileIfBehind(environmentId, event.thread.id, event.sequence);
      if (hasLocalActiveThreadWork(previousThread) && isSettlingShellThread(event.thread)) {
        requestThreadDetailReconcile(environmentId, event.thread.id, "shell-settled");
      }
      if (!previousThread && threadRef) {
        markPromotedDraftThreadByRef(threadRef);
      }
      if (previousThread?.archivedAt === null && event.thread.archivedAt !== null && threadRef) {
        useTerminalStateStore.getState().removeTerminalState(threadRef);
      }
      reconcileThreadDetailSubscriptionEvictionForThread(environmentId, event.thread.id);
      evictIdleThreadDetailSubscriptionsToCapacity();
      return;
    case "thread-removed":
      if (threadRef) {
        disposeThreadDetailSubscriptionByKey(scopedThreadKey(threadRef));
        useComposerDraftStore.getState().clearDraftThread(threadRef);
        useUiStateStore.getState().clearThreadUi(scopedThreadKey(threadRef));
        useTerminalStateStore.getState().removeTerminalState(threadRef);
      }
      syncThreadUiFromStore();
      return;
  }
}

function createEnvironmentConnectionHandlers() {
  return {
    applyShellEvent,
    syncShellSnapshot: (snapshot: OrchestrationShellSnapshot, environmentId: EnvironmentId) => {
      if (
        !shouldApplyProjectionSnapshot({
          current: readLastAppliedProjectionVersion(environmentId),
          next: snapshot,
        })
      ) {
        return;
      }

      useStore.getState().syncServerShellSnapshot(snapshot, environmentId);
      markAppliedProjectionSnapshot(environmentId, snapshot);
      reconcileThreadDetailSubscriptionsForEnvironment(
        environmentId,
        snapshot.threads.map((thread) => thread.id),
      );
      reconcileThreadDetailSubscriptionEvictionForEnvironment(environmentId);
      reconcileSnapshotDerivedState();
      scheduleEnvironmentStartupCacheWrite(environmentId);
    },
    applyTerminalEvent: (event: TerminalEvent, environmentId: EnvironmentId) => {
      const threadRef = scopeThreadRef(environmentId, ThreadId.make(event.threadId));
      const serverThread = selectThreadByRef(useStore.getState(), threadRef);
      const hasDraftThread =
        useComposerDraftStore.getState().getDraftThreadByRef(threadRef) !== null;
      if (
        !shouldApplyTerminalEvent({
          serverThreadArchivedAt: serverThread?.archivedAt,
          hasDraftThread,
        })
      ) {
        return;
      }
      useTerminalStateStore.getState().applyTerminalEvent(threadRef, event);
    },
  };
}

function createPrimaryEnvironmentClient(
  knownEnvironment: ReturnType<typeof getPrimaryKnownEnvironment>,
) {
  const wsBaseUrl = getKnownEnvironmentWsBaseUrl(knownEnvironment);
  if (!wsBaseUrl) {
    throw new Error(
      `Unable to resolve websocket URL for ${knownEnvironment?.label ?? "primary environment"}.`,
    );
  }
  const connectionLabel = knownEnvironment?.label ?? null;

  return createWsRpcClient(
    new WsTransport(wsBaseUrl, {
      getConnectionLabel: () => connectionLabel,
      getVersionMismatchHint: () =>
        resolveServerConfigVersionMismatch(getServerConfig())?.hint ?? null,
    }),
  );
}

function createSavedEnvironmentClient(
  environmentId: EnvironmentId,
  bearerToken: string,
): WsRpcClient {
  useSavedEnvironmentRuntimeStore.getState().ensure(environmentId);

  return createWsRpcClient(
    new WsTransport(
      async () => {
        const record = getSavedEnvironmentRecord(environmentId);
        if (!record) {
          throw new Error(`Saved environment ${environmentId} not found.`);
        }
        return record.desktopSsh
          ? await resolveDesktopSshWebSocketConnectionUrl(
              record.wsBaseUrl,
              record.httpBaseUrl,
              bearerToken,
            )
          : await resolveRemoteWebSocketConnectionUrl({
              wsBaseUrl: record.wsBaseUrl,
              httpBaseUrl: record.httpBaseUrl,
              bearerToken,
            });
      },
      {
        getConnectionLabel: () => getSavedEnvironmentRecord(environmentId)?.label ?? null,
        getVersionMismatchHint: () =>
          resolveServerConfigVersionMismatch(
            useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.serverConfig,
          )?.hint ?? null,
        onAttempt: () => {
          setRuntimeConnecting(environmentId);
        },
        onOpen: () => {
          setRuntimeConnected(environmentId);
        },
        onError: (message: string) => {
          const mismatch = resolveServerConfigVersionMismatch(
            useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.serverConfig,
          );
          useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
            connectionState: "error",
            lastError: appendVersionMismatchHint(message, mismatch),
            lastErrorAt: isoNow(),
          });
        },
        onClose: (
          details: { readonly code: number; readonly reason: string },
          context: WsProtocolCloseContext,
        ) => {
          if (context.intentional) {
            return;
          }
          setRuntimeDisconnected(
            environmentId,
            appendVersionMismatchHint(
              details.reason,
              resolveServerConfigVersionMismatch(
                useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.serverConfig,
              ),
            ),
          );
        },
      },
    ),
  );
}

async function refreshSavedEnvironmentMetadata(
  environmentId: EnvironmentId,
  bearerToken: string,
  client: WsRpcClient,
  roleHint?: AuthSessionRole | null,
  configHint?: ServerConfig | null,
): Promise<void> {
  const record = getSavedEnvironmentRecord(environmentId);
  if (!record) {
    throw new Error(`Saved environment ${environmentId} not found.`);
  }

  const [serverConfig, sessionState] = await Promise.all([
    configHint ? Promise.resolve(configHint) : client.server.getConfig(),
    record.desktopSsh
      ? fetchDesktopSshSessionState(record.httpBaseUrl, bearerToken)
      : fetchRemoteSessionState({
          httpBaseUrl: record.httpBaseUrl,
          bearerToken,
        }),
  ]);

  useSavedEnvironmentRuntimeStore.getState().patch(record.environmentId, {
    authState: sessionState.authenticated ? "authenticated" : "requires-auth",
    descriptor: serverConfig.environment,
    serverConfig,
    role: sessionState.authenticated ? (sessionState.role ?? roleHint ?? null) : null,
  });
  useSavedEnvironmentRegistryStore
    .getState()
    .rename(record.environmentId, serverConfig.environment.label);
}

function registerConnection(connection: EnvironmentConnection): EnvironmentConnection {
  const existing = environmentConnections.get(connection.environmentId);
  if (existing && existing !== connection) {
    throw new Error(`Environment ${connection.environmentId} already has an active connection.`);
  }
  environmentConnections.set(connection.environmentId, connection);
  attachThreadDetailSubscriptionsForEnvironment(connection.environmentId);
  emitEnvironmentConnectionRegistryChange();
  return connection;
}

async function removeConnection(environmentId: EnvironmentId): Promise<boolean> {
  const connection = environmentConnections.get(environmentId);
  if (!connection) {
    return false;
  }

  lastAppliedProjectionVersionByEnvironment.delete(environmentId);
  projectionRecoveryByEnvironment.delete(environmentId);
  connectionHealthRecoveryByEnvironment.delete(environmentId);
  browserResumeReconnectRetryByEnvironment.delete(environmentId);
  browserResumeShellBootstrapTimeoutByEnvironment.delete(environmentId);
  environmentConnections.delete(environmentId);
  emitEnvironmentConnectionRegistryChange();
  detachThreadDetailSubscriptionsForEnvironment(environmentId);
  await connection.dispose();
  return true;
}

function createPrimaryEnvironmentConnection(): EnvironmentConnection {
  const knownEnvironment = getPrimaryKnownEnvironment();
  if (!knownEnvironment?.environmentId) {
    throw new Error("Unable to resolve the primary environment.");
  }

  const existing = environmentConnections.get(knownEnvironment.environmentId);
  if (existing) {
    return existing;
  }

  hydrateEnvironmentFromStartupCache(knownEnvironment.environmentId);

  return registerConnection(
    createEnvironmentConnection({
      kind: "primary",
      knownEnvironment,
      client: createPrimaryEnvironmentClient(knownEnvironment),
      ...createEnvironmentConnectionHandlers(),
    }),
  );
}

function maybeCreatePrimaryEnvironmentConnection(): EnvironmentConnection | null {
  return getPrimaryKnownEnvironment()?.environmentId ? createPrimaryEnvironmentConnection() : null;
}

async function ensureSavedEnvironmentConnection(
  record: SavedEnvironmentRecord,
  options?: {
    readonly client?: WsRpcClient;
    readonly bearerToken?: string;
    readonly role?: AuthSessionRole | null;
    readonly serverConfig?: ServerConfig | null;
  },
): Promise<EnvironmentConnection> {
  hydrateEnvironmentFromStartupCache(record.environmentId);

  const existing = environmentConnections.get(record.environmentId);
  if (existing) {
    return existing;
  }

  const pending = pendingSavedEnvironmentConnections.get(record.environmentId);
  if (pending) {
    return pending.promise;
  }

  const pendingEntry: PendingSavedEnvironmentConnection = {
    cancelled: false,
    promise: Promise.resolve().then(async () => {
      let activeRecord = record;
      let roleHint = options?.role ?? null;
      let bearerToken =
        options?.bearerToken ?? (await readSavedEnvironmentBearerToken(record.environmentId));
      if (!bearerToken) {
        if (record.desktopSsh) {
          const issued = await issueDesktopSshBearerSession(record);
          activeRecord = issued.record;
          bearerToken = issued.bearerToken;
          roleHint = issued.role;
        } else {
          useSavedEnvironmentRuntimeStore.getState().patch(record.environmentId, {
            authState: "requires-auth",
            role: null,
            connectionState: "disconnected",
            lastError: "Saved environment is missing its saved credential. Pair it again.",
            lastErrorAt: isoNow(),
          });
          throw new Error("Saved environment is missing its saved credential.");
        }
      } else {
        const prepared = await prepareSavedEnvironmentRecordForConnection(record);
        activeRecord = prepared.record;
      }

      const activeBearerToken = bearerToken;
      const client =
        options?.client ??
        createSavedEnvironmentClient(activeRecord.environmentId, activeBearerToken);
      const initialConfigSnapshot = createDeferredPromise<ServerConfig>();
      const knownEnvironment = createKnownEnvironment({
        id: activeRecord.environmentId,
        label: activeRecord.label,
        source: "manual",
        target: {
          httpBaseUrl: activeRecord.httpBaseUrl,
          wsBaseUrl: activeRecord.wsBaseUrl,
        },
      });
      const connection = createEnvironmentConnection({
        kind: "saved",
        knownEnvironment: {
          ...knownEnvironment,
          environmentId: activeRecord.environmentId,
        },
        client,
        refreshMetadata: async () => {
          await refreshSavedEnvironmentMetadata(
            activeRecord.environmentId,
            activeBearerToken,
            client,
          );
        },
        onConfigSnapshot: (config) => {
          initialConfigSnapshot.resolve(config);
          useSavedEnvironmentRuntimeStore.getState().patch(activeRecord.environmentId, {
            descriptor: config.environment,
            serverConfig: config,
          });
        },
        onWelcome: (payload) => {
          useSavedEnvironmentRuntimeStore.getState().patch(activeRecord.environmentId, {
            descriptor: payload.environment,
          });
        },
        ...createEnvironmentConnectionHandlers(),
      });

      try {
        try {
          const initialServerConfig =
            options?.serverConfig ??
            (await waitForConfigSnapshot(
              initialConfigSnapshot.promise,
              INITIAL_SERVER_CONFIG_SNAPSHOT_WAIT_MS,
            ));
          await refreshSavedEnvironmentMetadata(
            activeRecord.environmentId,
            activeBearerToken,
            client,
            roleHint,
            initialServerConfig,
          );
        } catch (error) {
          const isAuthError = activeRecord.desktopSsh
            ? isSshHttpAuthError(error, 401)
            : isRemoteEnvironmentAuthHttpError(error) && error.status === 401;
          if (!isAuthError) {
            throw error;
          }
          if (!activeRecord.desktopSsh) {
            await removeSavedEnvironmentBearerToken(activeRecord.environmentId);
            throw new Error("Saved environment credential expired. Pair it again.", {
              cause: error,
            });
          }

          const issued = await issueDesktopSshBearerSession(activeRecord);
          activeRecord = issued.record;
          bearerToken = issued.bearerToken;
          roleHint = issued.role;
          await connection.dispose().catch(() => undefined);
          pendingSavedEnvironmentConnections.delete(activeRecord.environmentId);
          return await ensureSavedEnvironmentConnection(activeRecord, {
            bearerToken,
            role: roleHint,
            serverConfig: options?.serverConfig ?? null,
          });
        }
        if (
          pendingEntry.cancelled ||
          pendingSavedEnvironmentConnections.get(activeRecord.environmentId) !== pendingEntry
        ) {
          await connection.dispose().catch(() => undefined);
          throw new SavedEnvironmentConnectionCancelledError(activeRecord.environmentId);
        }
        registerConnection(connection);
        return connection;
      } catch (error) {
        if (error instanceof SavedEnvironmentConnectionCancelledError) {
          throw error;
        }
        setRuntimeError(activeRecord.environmentId, error);
        const removed = await removeConnection(activeRecord.environmentId).catch(() => false);
        if (!removed) {
          await connection.dispose().catch(() => undefined);
        }
        throw error;
      }
    }),
  };

  pendingSavedEnvironmentConnections.set(record.environmentId, pendingEntry);
  return await pendingEntry.promise.finally(() => {
    if (pendingSavedEnvironmentConnections.get(record.environmentId) === pendingEntry) {
      pendingSavedEnvironmentConnections.delete(record.environmentId);
    }
  });
}

async function syncSavedEnvironmentConnections(
  records: ReadonlyArray<SavedEnvironmentRecord>,
): Promise<void> {
  for (const record of records) {
    hydrateEnvironmentFromStartupCache(record.environmentId);
  }

  const expectedEnvironmentIds = new Set(records.map((record) => record.environmentId));
  const staleEnvironmentIds = [...environmentConnections.values()]
    .filter((connection) => connection.kind === "saved")
    .map((connection) => connection.environmentId)
    .filter((environmentId) => !expectedEnvironmentIds.has(environmentId));

  await Promise.all(
    staleEnvironmentIds.map((environmentId) => disconnectSavedEnvironment(environmentId)),
  );
  await Promise.all(
    records.map((record) => ensureSavedEnvironmentConnection(record).catch(() => undefined)),
  );
}

function stopActiveService() {
  activeService?.stop();
  activeService = null;
}

async function reconcileEnvironmentConnectionAfterBrowserResume(
  connection: EnvironmentConnection,
  reason: string,
  options: BrowserResumeReconcileOptions,
): Promise<void> {
  const environmentId = connection.environmentId;
  const startedAt = Date.now();
  // The periodic heartbeat-tick is a liveness check; only user-visible
  // resume events should force a detail refresh on the no-gap branch,
  // otherwise we'd churn the active thread every tick.
  const isUserResumeReason = reason !== "heartbeat-tick";
  const heartbeatFresh = connection.client.isHeartbeatFresh();

  recordResumeDiagnostic("browser-resume-reconcile-start", {
    reason,
    env: environmentId,
    data: {
      heartbeatFresh,
      forceReconnect: options.forceReconnect,
      hiddenDurationMs: options.hiddenDurationMs,
    },
  });

  const reconnectAfterResume = async (
    branch: string,
    refreshReason = `browser-resume:reconnect:${reason}`,
  ) => {
    const reconnectStartedAt = Date.now();
    try {
      await connection.reconnect({
        reason,
        shellBootstrapTimeoutMs: BROWSER_RESUME_RECONNECT_BOOTSTRAP_TIMEOUT_MS,
      });
      recordResumeDiagnostic("browser-resume-reconcile-branch", {
        reason,
        env: environmentId,
        data: {
          branch,
          elapsedMs: Date.now() - startedAt,
          reconnectElapsedMs: Date.now() - reconnectStartedAt,
        },
      });
      browserResumeShellBootstrapTimeoutByEnvironment.delete(environmentId);
      refreshActiveThreadDetailsForEnvironment(environmentId, refreshReason);
      refreshPendingNotificationThreadDetailsForEnvironment(
        environmentId,
        "notification-click:post-reconnect",
      );
    } catch (error) {
      const isShellBootstrapTimeout = isEnvironmentShellBootstrapTimeoutError(error);
      recordResumeDiagnostic("browser-resume-reconcile-error", {
        reason,
        env: environmentId,
        data: {
          branch,
          elapsedMs: Date.now() - startedAt,
          reconnectElapsedMs: Date.now() - reconnectStartedAt,
          error: isShellBootstrapTimeout ? "shell-bootstrap-timeout" : formatUnknownError(error),
          reconnectRetryCount: options.reconnectRetryCount,
          ...(isShellBootstrapTimeout
            ? {
                timeoutMs: error.timeoutMs,
              }
            : {}),
        },
      });
      throw error;
    }
  };

  // Fast path: if the heartbeat pong is stale, the underlying socket is
  // almost certainly dead (common on iOS PWA after backgrounding, where
  // the JS `WebSocket` may still report OPEN even though TCP is gone).
  // Skip the probe round-trip and reconnect immediately so thread detail
  // subscriptions re-attach on the new session.
  if (options.forceReconnect) {
    console.warn("Environment resumed after a long browser background; reconnecting", {
      environmentId,
      reason,
      hiddenDurationMs: options.hiddenDurationMs,
    });
    await reconnectAfterResume("long-background");
    return;
  }

  if (!heartbeatFresh) {
    console.warn("Environment heartbeat stale on browser resume; reconnecting", {
      environmentId,
      reason,
    });
    await reconnectAfterResume("stale-heartbeat");
    return;
  }

  const currentSequence = readLastAppliedProjectionVersion(environmentId)?.sequence;
  if (currentSequence === undefined) {
    recordResumeDiagnostic("browser-resume-reconcile-branch", {
      reason,
      env: environmentId,
      data: {
        branch: "no-local-sequence",
        elapsedMs: Date.now() - startedAt,
      },
    });
    return;
  }

  let step: "probeSync" | "replayEvents" | null = null;
  let stepStartedAt = 0;
  try {
    step = "probeSync";
    stepStartedAt = Date.now();
    const syncProbe = await withTimeout(
      connection.client.orchestration.probeSync({
        clientSequence: currentSequence,
      }),
      BROWSER_RESUME_RECONCILE_TIMEOUT_MS,
      () => new Error("Browser resume reconciliation timed out."),
    );
    recordResumeDiagnostic("browser-resume-probe", {
      reason,
      env: environmentId,
      data: {
        elapsedMs: Date.now() - stepStartedAt,
        clientSequence: currentSequence,
        serverSequence: syncProbe.serverSequence,
        behind: syncProbe.behind,
      },
    });
    if (readEnvironmentConnection(environmentId) !== connection) {
      recordResumeDiagnostic("browser-resume-reconcile-branch", {
        reason,
        env: environmentId,
        data: {
          branch: "stale-connection-after-probe",
          elapsedMs: Date.now() - startedAt,
        },
      });
      return;
    }
    const latestSequenceAfterProbe =
      readLastAppliedProjectionVersion(environmentId)?.sequence ?? currentSequence;
    if (!syncProbe.behind || syncProbe.serverSequence <= latestSequenceAfterProbe) {
      recordResumeDiagnostic("browser-resume-reconcile-branch", {
        reason,
        env: environmentId,
        data: {
          branch: "up-to-date",
          elapsedMs: Date.now() - startedAt,
          serverSequence: syncProbe.serverSequence,
          latestSequenceAfterProbe,
        },
      });
      if (isUserResumeReason) {
        refreshActiveThreadDetailsForEnvironment(
          environmentId,
          `browser-resume:up-to-date:${reason}`,
        );
      }
      return;
    }

    step = "replayEvents";
    stepStartedAt = Date.now();
    const replayedEvents = await withTimeout(
      connection.client.orchestration.replayEvents({
        fromSequenceExclusive: latestSequenceAfterProbe,
      }),
      BROWSER_RESUME_RECONCILE_TIMEOUT_MS,
      () => new Error("Browser resume replay timed out."),
    );
    recordResumeDiagnostic("browser-resume-replay", {
      reason,
      env: environmentId,
      data: {
        elapsedMs: Date.now() - stepStartedAt,
        fromSequenceExclusive: latestSequenceAfterProbe,
        eventCount: replayedEvents.length,
      },
    });
    if (readEnvironmentConnection(environmentId) !== connection) {
      recordResumeDiagnostic("browser-resume-reconcile-branch", {
        reason,
        env: environmentId,
        data: {
          branch: "stale-connection-after-replay",
          elapsedMs: Date.now() - startedAt,
        },
      });
      return;
    }

    const latestSequence =
      readLastAppliedProjectionVersion(environmentId)?.sequence ?? latestSequenceAfterProbe;
    const contiguousEvents = selectContiguousReplayEvents(replayedEvents, latestSequence);
    applyRecoveredProjectionEventBatch(contiguousEvents, environmentId);

    const recoveredSequence =
      readLastAppliedProjectionVersion(environmentId)?.sequence ?? latestSequence;
    const highestReplayedSequence = replayedEvents.reduce(
      (highest, event) => Math.max(highest, event.sequence),
      syncProbe.serverSequence,
    );
    if (highestReplayedSequence > recoveredSequence) {
      queueProjectionRecovery(environmentId, highestReplayedSequence);
    }
    recordResumeDiagnostic("browser-resume-reconcile-branch", {
      reason,
      env: environmentId,
      data: {
        branch: "replay",
        elapsedMs: Date.now() - startedAt,
        recoveredSequence,
        highestReplayedSequence,
        eventCount: replayedEvents.length,
      },
    });
    refreshActiveThreadDetailsForEnvironment(environmentId, `browser-resume:replay:${reason}`);
  } catch (error) {
    if (readEnvironmentConnection(environmentId) !== connection) {
      recordResumeDiagnostic("browser-resume-reconcile-branch", {
        reason,
        env: environmentId,
        data: {
          branch: "stale-connection-after-error",
          elapsedMs: Date.now() - startedAt,
          step,
          stepElapsedMs: step === null ? null : Date.now() - stepStartedAt,
        },
      });
      return;
    }

    recordResumeDiagnostic("browser-resume-reconcile-error", {
      reason,
      env: environmentId,
      data: {
        branch: "probe-or-replay-error",
        elapsedMs: Date.now() - startedAt,
        step,
        stepElapsedMs: step === null ? null : Date.now() - stepStartedAt,
        error: formatUnknownError(error),
      },
    });
    console.warn("Environment reconciliation after browser resume failed; reconnecting", {
      environmentId,
      reason,
      error: formatUnknownError(error),
    });
    await reconnectAfterResume(
      "reconnect-after-error",
      `browser-resume:reconnect-after-error:${reason}`,
    );
  }
}

async function reconcileEnvironmentConnectionForActiveThreadProjection(
  connection: EnvironmentConnection,
): Promise<void> {
  const environmentId = connection.environmentId;
  if (browserResumeReconciliationByEnvironment.has(environmentId)) {
    return;
  }

  if (!connection.client.isHeartbeatFresh()) {
    queueEnvironmentConnectionHealthRecoveryIfIdle(
      connection,
      "active-thread-detail-stale-heartbeat",
    );
    return;
  }

  const currentSequence = readLastAppliedProjectionVersion(environmentId)?.sequence;
  if (currentSequence === undefined) {
    return;
  }

  try {
    const syncProbe = await withTimeout(
      connection.client.orchestration.probeSync({
        clientSequence: currentSequence,
      }),
      BROWSER_RESUME_RECONCILE_TIMEOUT_MS,
      () => new Error("Browser resume reconciliation timed out."),
    );
    if (
      readEnvironmentConnection(environmentId) !== connection ||
      browserResumeReconciliationByEnvironment.has(environmentId)
    ) {
      return;
    }

    const latestSequenceAfterProbe =
      readLastAppliedProjectionVersion(environmentId)?.sequence ?? currentSequence;
    if (!syncProbe.behind || syncProbe.serverSequence <= latestSequenceAfterProbe) {
      return;
    }

    const replayedEvents = await withTimeout(
      connection.client.orchestration.replayEvents({
        fromSequenceExclusive: latestSequenceAfterProbe,
      }),
      BROWSER_RESUME_RECONCILE_TIMEOUT_MS,
      () => new Error("Browser resume replay timed out."),
    );
    if (
      readEnvironmentConnection(environmentId) !== connection ||
      browserResumeReconciliationByEnvironment.has(environmentId)
    ) {
      return;
    }

    const latestSequence =
      readLastAppliedProjectionVersion(environmentId)?.sequence ?? latestSequenceAfterProbe;
    const contiguousEvents = selectContiguousReplayEvents(replayedEvents, latestSequence);
    applyRecoveredProjectionEventBatch(contiguousEvents, environmentId);

    const recoveredSequence =
      readLastAppliedProjectionVersion(environmentId)?.sequence ?? latestSequence;
    const highestReplayedSequence = replayedEvents.reduce(
      (highest, event) => Math.max(highest, event.sequence),
      syncProbe.serverSequence,
    );
    if (highestReplayedSequence > recoveredSequence) {
      queueProjectionRecovery(environmentId, highestReplayedSequence);
    }
  } catch (error) {
    if (
      readEnvironmentConnection(environmentId) !== connection ||
      browserResumeReconciliationByEnvironment.has(environmentId)
    ) {
      return;
    }

    if (shouldRecoverConnectionFromActiveProjectionError(error)) {
      queueEnvironmentConnectionHealthRecoveryIfIdle(
        connection,
        "active-thread-detail:probe-failed",
        error,
      );
      return;
    }

    console.warn("Active thread projection reconciliation failed without reconnecting", {
      environmentId,
      reason: "active-thread-detail",
      error: formatUnknownError(error),
    });
  }
}

function queueEnvironmentActiveThreadProjectionReconciliation(
  connection: EnvironmentConnection,
): void {
  const environmentId = connection.environmentId;
  if (
    browserResumeReconciliationByEnvironment.has(environmentId) ||
    activeThreadProjectionReconciliationByEnvironment.has(environmentId)
  ) {
    return;
  }

  const promise = reconcileEnvironmentConnectionForActiveThreadProjection(connection).catch(
    (error) => {
      console.warn("Active thread projection reconciliation failed", {
        environmentId,
        error: formatUnknownError(error),
      });
    },
  );

  activeThreadProjectionReconciliationByEnvironment.set(environmentId, promise);
  void promise.finally(() => {
    if (activeThreadProjectionReconciliationByEnvironment.get(environmentId) === promise) {
      activeThreadProjectionReconciliationByEnvironment.delete(environmentId);
    }
  });
}

function scheduleBrowserResumeReconnectRetry(
  environmentId: EnvironmentId,
  followUp: BrowserResumeQueuedFollowUp,
): void {
  browserResumeShellBootstrapTimeoutByEnvironment.delete(environmentId);
  browserResumeReconnectRetryByEnvironment.set(environmentId, followUp);
  recordResumeDiagnostic("browser-resume-queue", {
    reason: followUp.reason,
    env: environmentId,
    data: {
      action: "queued-timeout-retry",
      forceReconnect: followUp.options.forceReconnect,
      hiddenDurationMs: followUp.options.hiddenDurationMs,
      reconnectRetryCount: followUp.options.reconnectRetryCount,
      retryDelayMs: BROWSER_RESUME_RECONNECT_RETRY_DELAY_MS,
    },
  });

  const timeoutId = setTimeout(() => {
    browserResumeReconnectRetryTimeoutIds.delete(timeoutId);
    if (browserResumeReconnectRetryByEnvironment.get(environmentId) !== followUp) {
      return;
    }
    browserResumeReconnectRetryByEnvironment.delete(environmentId);

    const currentConnection = readEnvironmentConnection(environmentId);
    if (!currentConnection) {
      recordResumeDiagnostic("browser-resume-queue", {
        reason: followUp.reason,
        env: environmentId,
        data: {
          action: "queued-timeout-retry-dropped",
          forceReconnect: followUp.options.forceReconnect,
          hiddenDurationMs: followUp.options.hiddenDurationMs,
          reconnectRetryCount: followUp.options.reconnectRetryCount,
        },
      });
      return;
    }
    queueEnvironmentBrowserResumeReconciliation(
      currentConnection,
      followUp.reason,
      followUp.options,
    );
  }, BROWSER_RESUME_RECONNECT_RETRY_DELAY_MS);
  browserResumeReconnectRetryTimeoutIds.add(timeoutId);
}

function queueEnvironmentBrowserResumeReconciliation(
  connection: EnvironmentConnection,
  reason: string,
  options: BrowserResumeReconcileOptions,
): void {
  const environmentId = connection.environmentId;
  const scheduledRetry = browserResumeReconnectRetryByEnvironment.get(environmentId);
  if (scheduledRetry) {
    recordResumeDiagnostic("browser-resume-queue", {
      reason,
      env: environmentId,
      data: {
        action: "coalesced-timeout-retry",
        forceReconnect: options.forceReconnect,
        hiddenDurationMs: options.hiddenDurationMs,
        inFlightReason: scheduledRetry.reason,
        inFlightForceReconnect: scheduledRetry.options.forceReconnect,
      },
    });
    return;
  }

  const existing = browserResumeReconciliationByEnvironment.get(environmentId);
  if (existing) {
    const queueForcedFollowUp = options.forceReconnect && !existing.forceReconnect;
    if (queueForcedFollowUp) {
      existing.queuedFollowUp = {
        reason,
        options,
      };
    }
    recordResumeDiagnostic("browser-resume-queue", {
      reason,
      env: environmentId,
      data: {
        action: queueForcedFollowUp ? "queued-forced-follow-up" : "coalesced",
        forceReconnect: options.forceReconnect,
        hiddenDurationMs: options.hiddenDurationMs,
        inFlightReason: existing.reason,
        inFlightForceReconnect: existing.forceReconnect,
        coalescedIntoForcedReconnect: existing.forceReconnect && options.forceReconnect,
      },
    });
    return;
  }

  recordResumeDiagnostic("browser-resume-queue", {
    reason,
    env: environmentId,
    data: {
      action: "scheduled",
      forceReconnect: options.forceReconnect,
      hiddenDurationMs: options.hiddenDurationMs,
    },
  });

  let failure: unknown = null;
  const promise = reconcileEnvironmentConnectionAfterBrowserResume(
    connection,
    reason,
    options,
  ).catch((error: unknown) => {
    failure = error;
    console.warn("Environment reconnect after browser resume failed", {
      environmentId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  });

  const state: BrowserResumeReconciliationState = {
    promise,
    reason,
    forceReconnect: options.forceReconnect,
    queuedFollowUp: null,
  };
  browserResumeReconciliationByEnvironment.set(environmentId, state);
  void promise.finally(() => {
    if (browserResumeReconciliationByEnvironment.get(environmentId) !== state) {
      return;
    }
    browserResumeReconciliationByEnvironment.delete(environmentId);
    if (
      isEnvironmentShellBootstrapTimeoutError(failure) &&
      options.forceReconnect &&
      options.reconnectRetryCount < BROWSER_RESUME_RECONNECT_MAX_RETRY_COUNT
    ) {
      scheduleBrowserResumeReconnectRetry(environmentId, {
        reason: "browser-resume:retry-after-shell-bootstrap-timeout",
        options: {
          hiddenDurationMs: options.hiddenDurationMs,
          forceReconnect: true,
          reconnectRetryCount: options.reconnectRetryCount + 1,
        },
      });
      return;
    }
    if (isEnvironmentShellBootstrapTimeoutError(failure) && options.forceReconnect) {
      browserResumeShellBootstrapTimeoutByEnvironment.set(environmentId, {
        failedAt: Date.now(),
        reconnectRetryCount: options.reconnectRetryCount,
        timeoutMs: failure.timeoutMs,
      });
      recordResumeDiagnostic("browser-resume-queue", {
        reason,
        env: environmentId,
        data: {
          action: "timeout-retry-exhausted",
          forceReconnect: options.forceReconnect,
          hiddenDurationMs: options.hiddenDurationMs,
          reconnectRetryCount: options.reconnectRetryCount,
          timeoutMs: failure.timeoutMs,
        },
      });
    }
    const followUp = state.queuedFollowUp;
    if (followUp === null) {
      return;
    }
    const currentConnection = readEnvironmentConnection(environmentId);
    if (!currentConnection) {
      recordResumeDiagnostic("browser-resume-queue", {
        reason: followUp.reason,
        env: environmentId,
        data: {
          action: "queued-forced-follow-up-dropped",
          forceReconnect: followUp.options.forceReconnect,
          hiddenDurationMs: followUp.options.hiddenDurationMs,
        },
      });
      return;
    }
    queueEnvironmentBrowserResumeReconciliation(
      currentConnection,
      followUp.reason,
      followUp.options,
    );
  });
}

function reconcileEnvironmentConnectionsAfterBrowserResume(
  reason: string,
  options: BrowserResumeReconcileOptions = makeBrowserResumeReconcileOptions(reason, null),
): void {
  const now = Date.now();
  if (options.forceReconnect) {
    lastBrowserResumeReconcileAt = Number.NEGATIVE_INFINITY;
  }
  if (now - lastBrowserResumeReconcileAt < BROWSER_RESUME_RECONCILE_COOLDOWN_MS) {
    recordResumeDiagnostic("browser-resume-queue", {
      reason,
      data: {
        action: "cooldown-suppressed",
        elapsedSinceLastMs: now - lastBrowserResumeReconcileAt,
        forceReconnect: options.forceReconnect,
        hiddenDurationMs: options.hiddenDurationMs,
      },
    });
    return;
  }
  lastBrowserResumeReconcileAt = now;

  for (const connection of environmentConnections.values()) {
    queueEnvironmentBrowserResumeReconciliation(connection, reason, options);
  }
}

function consumePendingNotificationThreadReconcile(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): boolean {
  const now = Date.now();
  hydratePendingNotificationThreadReconciles(now);
  const key = getThreadDetailSubscriptionKey(environmentId, threadId);
  const pending = pendingNotificationThreadReconcileKeys.get(key);
  if (pending === undefined) {
    return false;
  }
  const retainedReason = getPendingNotificationThreadReconcileRetainBlockReason(environmentId);
  const consumed = retainedReason === null && deletePendingNotificationThreadReconcile(key);
  const previousDiagnostic = pendingNotificationThreadReconcileConsumeDiagnostics.get(key);
  const shouldRecord =
    consumed ||
    previousDiagnostic === undefined ||
    previousDiagnostic.retainedReason !== retainedReason ||
    now - previousDiagnostic.loggedAt >=
      PENDING_NOTIFICATION_THREAD_RECONCILE_CONSUME_DIAGNOSTIC_INTERVAL_MS;
  if (shouldRecord) {
    pendingNotificationThreadReconcileConsumeDiagnostics.set(key, {
      retainedReason,
      loggedAt: now,
    });
    recordResumeDiagnostic("notification-thread-reconcile-consume", {
      env: environmentId,
      data: {
        threadId,
        consumed,
        retainedReason,
        pendingAgeMs: now - pending.createdAt,
        pendingCount: pendingNotificationThreadReconcileKeys.size,
      },
    });
  }
  return consumed;
}

export function reconcileAfterNotificationClick(
  target: NotificationNavigationTarget,
  metadata?: NotificationClickReconcileMetadata,
): void {
  // Notification click is a single, explicit user signal. Bypass the
  // 2s browser-resume cooldown so we don't get coalesced with a
  // visibilitychange that may have fired moments earlier. Per-env queueing
  // still coalesces duplicate work, but a forced notification-click reconcile
  // can now schedule a forced follow-up behind a weaker in-flight reconcile.
  const now = Date.now();
  hydratePendingNotificationThreadReconciles(now);
  const {
    hiddenDurationMs,
    hiddenDurationSource,
    resumeSignalAgeMs,
    recentResumeReason,
    recentResumeForceReconnect,
  } = resolveNotificationClickHiddenDuration(now);
  const options = makeBrowserResumeReconcileOptions("notification-click", hiddenDurationMs);
  recordResumeDiagnostic("notification-click", {
    reason: "notification-click",
    ...(target.kind === "thread" ? { env: target.environmentId } : {}),
    data: {
      target,
      openedAt: sanitizeNotificationOpenedAt(metadata?.openedAt),
      hiddenDurationMs,
      hiddenDurationSource,
      resumeSignalAgeMs,
      recentResumeReason,
      recentResumeForceReconnect,
      forceReconnect: options.forceReconnect,
    },
  });
  if (target.kind === "thread") {
    // The thread route hasn't mounted yet, so its detail subscription
    // doesn't exist. Stash the target so the next matching
    // retainActiveThreadDetailSubscription call forces an immediate
    // reconcile once the connection is fresh, even on the no-events-replayed
    // branch.
    setPendingNotificationThreadReconcile(target, now);
  }
  lastBrowserResumeReconcileAt = Number.NEGATIVE_INFINITY;
  reconcileEnvironmentConnectionsAfterBrowserResume("notification-click", options);
}

function subscribeBrowserResumeReconnects(): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return NOOP;
  }

  const handleVisibilityChange = () => {
    const now = Date.now();
    if (document.visibilityState === "hidden") {
      lastBrowserHiddenAt = now;
      recordResumeDiagnostic("browser-event", {
        reason: "visibilitychange:hidden",
        data: {
          visibilityState: document.visibilityState,
        },
      });
      flushResumeDiagnostics();
      return;
    }
    if (document.visibilityState === "visible" && lastBrowserHiddenAt !== null) {
      const hiddenDurationMs = getBrowserHiddenDuration(now);
      const options = makeBrowserResumeReconcileOptions("visibilitychange", hiddenDurationMs);
      rememberRecentBrowserResumeContext("visibilitychange", hiddenDurationMs, options, now);
      recordResumeDiagnostic("browser-event", {
        reason: "visibilitychange:visible",
        data: {
          visibilityState: document.visibilityState,
          hiddenDurationMs,
          forceReconnect: options.forceReconnect,
        },
      });
      lastBrowserHiddenAt = null;
      reconcileEnvironmentConnectionsAfterBrowserResume("visibilitychange", options);
    }
  };

  const handlePageHide = () => {
    lastBrowserHiddenAt = Date.now();
    recordResumeDiagnostic("browser-event", {
      reason: "pagehide",
      data: {
        visibilityState: document.visibilityState,
      },
    });
    flushResumeDiagnostics();
  };

  const handlePageShow = (event: PageTransitionEvent) => {
    const now = Date.now();
    const hadPriorBackgroundSignal = lastBrowserHiddenAt !== null;
    const shouldReconcile =
      event.persisted || hadPriorBackgroundSignal || hasRetainedThreadDetailSubscription();
    const hiddenDurationMs = hadPriorBackgroundSignal ? getBrowserHiddenDuration(now) : null;
    const reason = event.persisted
      ? "pageshow:bfcache"
      : hadPriorBackgroundSignal
        ? "pageshow"
        : "pageshow:visible";
    const options = makeBrowserResumeReconcileOptions(reason, hiddenDurationMs);
    rememberRecentBrowserResumeContext(reason, hiddenDurationMs, options, now);
    lastBrowserHiddenAt = null;
    recordResumeDiagnostic("browser-event", {
      reason,
      data: {
        persisted: event.persisted,
        hadPriorBackgroundSignal,
        shouldReconcile,
        hiddenDurationMs,
        forceReconnect: options.forceReconnect,
      },
    });
    if (shouldReconcile) {
      reconcileEnvironmentConnectionsAfterBrowserResume(reason, options);
    }
  };

  const handleWindowFocus = () => {
    if (document.visibilityState !== "visible") {
      recordResumeDiagnostic("browser-event", {
        reason: "focus:hidden",
        data: {
          visibilityState: document.visibilityState,
        },
      });
      return;
    }
    const now = Date.now();
    const hadPriorBackgroundSignal = lastBrowserHiddenAt !== null;
    if (!hadPriorBackgroundSignal && !hasRetainedThreadDetailSubscription()) {
      recordResumeDiagnostic("browser-event", {
        reason: "focus:ignored",
        data: {
          hadPriorBackgroundSignal,
          retainedThreadDetail: false,
        },
      });
      return;
    }
    const hiddenDurationMs = hadPriorBackgroundSignal ? getBrowserHiddenDuration(now) : null;
    lastBrowserHiddenAt = null;
    const reason = hadPriorBackgroundSignal ? "focus" : "focus:visible";
    const options = makeBrowserResumeReconcileOptions(reason, hiddenDurationMs);
    rememberRecentBrowserResumeContext(reason, hiddenDurationMs, options, now);
    recordResumeDiagnostic("browser-event", {
      reason,
      data: {
        hadPriorBackgroundSignal,
        hiddenDurationMs,
        forceReconnect: options.forceReconnect,
      },
    });
    reconcileEnvironmentConnectionsAfterBrowserResume(reason, options);
  };

  const handleHeartbeatTick = () => {
    recordResumeDiagnostic("browser-event", {
      reason: "heartbeat-tick",
      data: {
        visibilityState: document.visibilityState,
        hiddenDurationMs: getBrowserHiddenDuration(Date.now()),
      },
    });
    if (document.visibilityState !== "visible") {
      return;
    }
    reconcileEnvironmentConnectionsAfterBrowserResume(
      "heartbeat-tick",
      makeBrowserResumeReconcileOptions("heartbeat-tick", null),
    );
  };

  // Top-level liveness tick. Visibility/pageshow/focus only fire on
  // transitions; a connection that silently dies while the tab stays
  // visible (network blip, server restart, etc.) is only caught by the
  // 5s active-thread probe — and that probe doesn't run on views with
  // no retained thread (sidebar/home). Reuse the browser-resume path
  // so the cooldown and per-environment queueing apply unchanged.
  const heartbeatTickIntervalId = setInterval(
    handleHeartbeatTick,
    BROWSER_RESUME_HEARTBEAT_TICK_MS,
  );

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pagehide", handlePageHide);
  window.addEventListener("pageshow", handlePageShow);
  window.addEventListener("focus", handleWindowFocus);
  return () => {
    clearInterval(heartbeatTickIntervalId);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("pagehide", handlePageHide);
    window.removeEventListener("pageshow", handlePageShow);
    window.removeEventListener("focus", handleWindowFocus);
  };
}

export function subscribeEnvironmentConnections(listener: () => void): () => void {
  environmentConnectionListeners.add(listener);
  return () => {
    environmentConnectionListeners.delete(listener);
  };
}

export function listEnvironmentConnections(): ReadonlyArray<EnvironmentConnection> {
  return [...environmentConnections.values()];
}

export function readEnvironmentConnection(
  environmentId: EnvironmentId,
): EnvironmentConnection | null {
  return environmentConnections.get(environmentId) ?? null;
}

export function requireEnvironmentConnection(environmentId: EnvironmentId): EnvironmentConnection {
  const connection = readEnvironmentConnection(environmentId);
  if (!connection) {
    throw new Error(`No websocket client registered for environment ${environmentId}.`);
  }
  return connection;
}

export function getPrimaryEnvironmentConnection(): EnvironmentConnection {
  return createPrimaryEnvironmentConnection();
}

export async function disconnectSavedEnvironment(environmentId: EnvironmentId): Promise<void> {
  const record = getSavedEnvironmentRecord(environmentId);
  const pendingConnection = pendingSavedEnvironmentConnections.get(environmentId);
  if (pendingConnection) {
    pendingConnection.cancelled = true;
    pendingSavedEnvironmentConnections.delete(environmentId);
  }
  const connection = environmentConnections.get(environmentId);

  if (connection?.kind === "saved") {
    await removeConnection(environmentId).catch(() => false);
  }
  setRuntimeDisconnected(environmentId);

  if (record?.desktopSsh && typeof window !== "undefined") {
    await window.desktopBridge?.disconnectSshEnvironment(record.desktopSsh);
    await removeSavedEnvironmentBearerToken(environmentId);
  }
}

export async function reconnectSavedEnvironment(environmentId: EnvironmentId): Promise<void> {
  const record = getSavedEnvironmentRecord(environmentId);
  if (!record) {
    throw new Error("Saved environment not found.");
  }

  const connection = environmentConnections.get(environmentId);
  if (!connection) {
    setRuntimeConnecting(environmentId);
    try {
      await ensureSavedEnvironmentConnection(record);
      return;
    } catch (error) {
      if (isSavedEnvironmentConnectionCancelledError(error)) {
        return;
      }
      setRuntimeError(environmentId, error);
      throw error;
    }
  }

  setRuntimeConnecting(environmentId);
  try {
    if (record.desktopSsh) {
      await prepareSavedEnvironmentRecordForConnection(record);
    }
    await connection.reconnect();
  } catch (error) {
    if (record.desktopSsh) {
      try {
        const issued = await issueDesktopSshBearerSession(
          getSavedEnvironmentRecord(environmentId) ?? record,
        );
        await removeConnection(environmentId).catch(() => false);
        await ensureSavedEnvironmentConnection(issued.record, {
          bearerToken: issued.bearerToken,
          role: issued.role,
        });
        return;
      } catch (recoveryError) {
        if (isSavedEnvironmentConnectionCancelledError(recoveryError)) {
          return;
        }
        setRuntimeError(environmentId, recoveryError);
        throw recoveryError;
      }
    }
    setRuntimeError(environmentId, error);
    throw error;
  }
}

export async function removeSavedEnvironment(environmentId: EnvironmentId): Promise<void> {
  await disconnectSavedEnvironment(environmentId);
  disposeThreadDetailSubscriptionsForEnvironment(environmentId);
  removeCachedEnvironmentState(environmentId);
  useSavedEnvironmentRegistryStore.getState().remove(environmentId);
  useSavedEnvironmentRuntimeStore.getState().clear(environmentId);
  useStore.getState().removeEnvironmentState(environmentId);
  await removeSavedEnvironmentBearerToken(environmentId);
}

export async function addSavedEnvironment(input: {
  readonly label: string;
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
  readonly desktopSsh?: DesktopSshEnvironmentTarget;
}): Promise<SavedEnvironmentRecord> {
  const resolvedTarget = resolveRemotePairingTarget({
    ...(input.pairingUrl !== undefined ? { pairingUrl: input.pairingUrl } : {}),
    ...(input.host !== undefined ? { host: input.host } : {}),
    ...(input.pairingCode !== undefined ? { pairingCode: input.pairingCode } : {}),
  });
  const descriptor = input.desktopSsh
    ? await fetchDesktopSshEnvironmentDescriptor(resolvedTarget.httpBaseUrl)
    : await fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: resolvedTarget.httpBaseUrl,
      });
  const environmentId = descriptor.environmentId;
  const registrySnapshot = snapshotSavedEnvironmentRegistry([environmentId]);
  const existingRecord =
    getSavedEnvironmentRecord(environmentId) ??
    findSavedEnvironmentRecordByDesktopSshTarget(input.desktopSsh);
  const staleDesktopSshRecord =
    existingRecord && existingRecord.environmentId !== environmentId ? existingRecord : null;

  const bearerSession = input.desktopSsh
    ? await bootstrapDesktopSshBearerSession(resolvedTarget.httpBaseUrl, resolvedTarget.credential)
    : await bootstrapRemoteBearerSession({
        httpBaseUrl: resolvedTarget.httpBaseUrl,
        credential: resolvedTarget.credential,
      });

  const record: SavedEnvironmentRecord = {
    environmentId,
    label: input.label.trim() || existingRecord?.label || descriptor.label,
    wsBaseUrl: resolvedTarget.wsBaseUrl,
    httpBaseUrl: resolvedTarget.httpBaseUrl,
    createdAt: existingRecord?.createdAt ?? isoNow(),
    lastConnectedAt: isoNow(),
    ...((input.desktopSsh ?? existingRecord?.desktopSsh)
      ? { desktopSsh: input.desktopSsh ?? existingRecord?.desktopSsh }
      : {}),
  };

  await persistSavedEnvironmentRecord(record);
  const didPersistBearerToken = await writeSavedEnvironmentBearerToken(
    environmentId,
    bearerSession.sessionToken,
  );
  if (!didPersistBearerToken) {
    await persistSavedEnvironmentRegistryRollback(registrySnapshot);
    throw new Error("Unable to persist saved environment credentials.");
  }
  useSavedEnvironmentRegistryStore.getState().upsert(record);
  if (staleDesktopSshRecord) {
    await removeSavedEnvironment(staleDesktopSshRecord.environmentId);
  }
  await removeConnection(environmentId).catch(() => false);
  await ensureSavedEnvironmentConnection(record, {
    bearerToken: bearerSession.sessionToken,
    role: bearerSession.role,
  });
  return record;
}

export async function connectDesktopSshEnvironment(
  target: DesktopSshEnvironmentTarget,
  options?: { label?: string },
): Promise<SavedEnvironmentRecord> {
  const bootstrap = await resolveDesktopSshEnvironmentBootstrap(target, {
    issuePairingToken: true,
  });
  if (!bootstrap.pairingToken) {
    throw new Error("Desktop SSH launch did not return a pairing token.");
  }

  return await addSavedEnvironment({
    label: options?.label?.trim() || bootstrap.target.alias,
    host: bootstrap.httpBaseUrl,
    pairingCode: bootstrap.pairingToken,
    desktopSsh: bootstrap.target,
  }).catch((error) => {
    const detail = [
      `local ${bootstrap.httpBaseUrl}`,
      `remote port ${bootstrap.remotePort ?? "unknown"}`,
      bootstrap.remoteServerKind ? `remote server ${bootstrap.remoteServerKind}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} (${detail})`);
  });
}

export async function ensureEnvironmentConnectionBootstrapped(
  environmentId: EnvironmentId,
): Promise<void> {
  await environmentConnections.get(environmentId)?.ensureBootstrapped();
}

export function startEnvironmentConnectionService(queryClient: QueryClient): () => void {
  if (activeService?.queryClient === queryClient) {
    activeService.refCount += 1;
    return () => {
      if (!activeService || activeService.queryClient !== queryClient) {
        return;
      }
      activeService.refCount -= 1;
      if (activeService.refCount === 0) {
        stopActiveService();
      }
    };
  }

  stopActiveService();
  needsProviderInvalidation = false;
  const queryInvalidationThrottler = new Throttler(
    () => {
      if (!needsProviderInvalidation) {
        return;
      }
      needsProviderInvalidation = false;
      void queryClient.invalidateQueries({ queryKey: providerQueryKeys.all });
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
    },
    {
      wait: 100,
      leading: false,
      trailing: true,
    },
  );
  const requestSavedEnvironmentSync = createSavedEnvironmentSyncScheduler();

  hydratePendingNotificationThreadReconciles(Date.now());
  maybeCreatePrimaryEnvironmentConnection();

  const unsubscribeSavedEnvironments = useSavedEnvironmentRegistryStore.subscribe(() => {
    if (!hasSavedEnvironmentRegistryHydrated()) {
      return;
    }
    void requestSavedEnvironmentSync();
  });

  void waitForSavedEnvironmentRegistryHydration()
    .then(() => requestSavedEnvironmentSync())
    .catch(() => undefined);

  const unsubscribeBrowserResumeReconnects = subscribeBrowserResumeReconnects();

  activeService = {
    queryClient,
    queryInvalidationThrottler,
    refCount: 1,
    stop: () => {
      unsubscribeSavedEnvironments();
      unsubscribeBrowserResumeReconnects();
      queryInvalidationThrottler.cancel();
    },
  };

  return () => {
    if (!activeService || activeService.queryClient !== queryClient) {
      return;
    }
    activeService.refCount -= 1;
    if (activeService.refCount === 0) {
      stopActiveService();
    }
  };
}

export async function resetEnvironmentServiceForTests(): Promise<void> {
  stopActiveService();
  lastBrowserHiddenAt = null;
  recentBrowserResumeContext = null;
  lastBrowserResumeReconcileAt = Number.NEGATIVE_INFINITY;
  pendingNotificationThreadReconcileKeys.clear();
  pendingNotificationThreadReconcilesHydrated = false;
  pendingNotificationThreadReconcileConsumeDiagnostics.clear();
  browserResumeReconnectRetryByEnvironment.clear();
  browserResumeShellBootstrapTimeoutByEnvironment.clear();
  for (const timeoutId of browserResumeReconnectRetryTimeoutIds) {
    clearTimeout(timeoutId);
  }
  browserResumeReconnectRetryTimeoutIds.clear();
  browserResumeReconciliationByEnvironment.clear();
  activeThreadProjectionReconciliationByEnvironment.clear();
  lastAppliedProjectionVersionByEnvironment.clear();
  projectionRecoveryByEnvironment.clear();
  connectionHealthRecoveryByEnvironment.clear();
  pendingSavedEnvironmentConnections.clear();
  for (const key of Array.from(threadDetailSubscriptions.keys())) {
    disposeThreadDetailSubscriptionByKey(key);
  }
  await Promise.all(
    [...environmentConnections.keys()].map((environmentId) => removeConnection(environmentId)),
  );
}
