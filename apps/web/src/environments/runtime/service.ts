import {
  type AuthSessionRole,
  type DesktopSshEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
  type EnvironmentId,
  type OrchestrationEvent,
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
import { createEnvironmentConnection, type EnvironmentConnection } from "./connection";
import {
  useStore,
  selectProjectsAcrossEnvironments,
  selectSidebarThreadSummaryByRef,
  selectThreadByRef,
  selectThreadsAcrossEnvironments,
} from "~/store";
import { useTerminalStateStore } from "~/terminalStateStore";
import { useUiStateStore } from "~/uiStateStore";
import type { WsProtocolCloseContext } from "../../rpc/protocol";
import { getServerConfig } from "../../rpc/serverState";
import { WsTransport } from "../../rpc/wsTransport";
import { createWsRpcClient, type WsRpcClient } from "../../rpc/wsRpcClient";
import { appendVersionMismatchHint, resolveServerConfigVersionMismatch } from "../../versionSkew";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
} from "../../logicalProject";
import { getClientSettings } from "~/hooks/useSettings";
import {
  readCachedEnvironmentState,
  removeCachedEnvironmentState,
  scheduleCachedEnvironmentStateWrite,
} from "~/orchestrationStartupCache";

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
  latestDetailSequence: number | null;
  refreshTargetSequence: number | null;
  refreshTimeoutId: ReturnType<typeof setTimeout> | null;
  activeReconcileIntervalId: ReturnType<typeof setInterval> | null;
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

interface RecoveredEventBatchOptions {
  readonly preserveShellFields?: boolean;
}

const pendingSavedEnvironmentConnections = new Map<
  EnvironmentId,
  PendingSavedEnvironmentConnection
>();
const environmentConnectionListeners = new Set<() => void>();
const threadDetailSubscriptions = new Map<string, ThreadDetailSubscriptionEntry>();
const browserResumeReconciliationByEnvironment = new Map<EnvironmentId, Promise<void>>();
const lastAppliedProjectionVersionByEnvironment = new Map<
  EnvironmentId,
  {
    readonly sequence: number;
    readonly updatedAt: string | null;
  }
>();
const projectionRecoveryByEnvironment = new Map<EnvironmentId, ProjectionRecovery>();

let activeService: EnvironmentServiceState | null = null;
let needsProviderInvalidation = false;
let lastBrowserHiddenAt: number | null = null;
let lastBrowserResumeReconcileAt = Number.NEGATIVE_INFINITY;

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
const BROWSER_RESUME_RECONCILE_COOLDOWN_MS = 2_000;
const BROWSER_RESUME_RECONCILE_TIMEOUT_MS = 1_500;
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

  applyRecoveredEventBatch(events, environmentId);
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
    scheduleThreadDetailRefreshIfBehind(environmentId, threadId, event.sequence);
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

function clearThreadDetailSubscriptionRefresh(entry: ThreadDetailSubscriptionEntry): void {
  if (entry.refreshTimeoutId !== null) {
    clearTimeout(entry.refreshTimeoutId);
    entry.refreshTimeoutId = null;
  }
  entry.refreshTargetSequence = null;
}

function clearThreadDetailSubscriptionActiveReconcile(entry: ThreadDetailSubscriptionEntry): void {
  if (entry.activeReconcileIntervalId !== null) {
    clearInterval(entry.activeReconcileIntervalId);
    entry.activeReconcileIntervalId = null;
  }
}

function markThreadDetailSequence(entry: ThreadDetailSubscriptionEntry, sequence: number): void {
  entry.latestDetailSequence =
    entry.latestDetailSequence === null ? sequence : Math.max(entry.latestDetailSequence, sequence);

  if (
    entry.refreshTargetSequence !== null &&
    entry.latestDetailSequence >= entry.refreshTargetSequence
  ) {
    clearThreadDetailSubscriptionRefresh(entry);
  }
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

// Detects the iOS PWA "stuck running" gap: the session still claims the
// active turn id while the same latestTurn already reports a completedAt.
// In normal operation this state is transient (the closing
// `thread.session-set` event arrives moments after `thread.turn-diff-completed`),
// but iOS Safari can drop the closing event when the tab is backgrounded.
// The active session remains authoritative in live UI because a completed
// assistant message can arrive before the provider turn is done. This refresh
// path exists specifically for resume reconciliation, where the browser may
// have missed the closing `thread.session-set` event.
function isThreadDetailSubscriptionStuckOnCompletedRunningTurn(
  entry: ThreadDetailSubscriptionEntry,
): boolean {
  const thread = selectThreadByRef(
    useStore.getState(),
    scopeThreadRef(entry.environmentId, entry.threadId),
  );
  const session = thread?.session;
  const latestTurn = thread?.latestTurn;
  if (!session || !latestTurn) {
    return false;
  }
  return (
    session.orchestrationStatus === "running" &&
    session.activeTurnId !== undefined &&
    session.activeTurnId !== null &&
    latestTurn.turnId === session.activeTurnId &&
    latestTurn.completedAt !== undefined &&
    latestTurn.completedAt !== null
  );
}

function refreshThreadDetailSubscriptionsStuckOnCompletedRunningTurn(
  environmentId: EnvironmentId,
): void {
  for (const entry of threadDetailSubscriptions.values()) {
    if (entry.environmentId !== environmentId) {
      continue;
    }
    if (!isThreadDetailSubscriptionStuckOnCompletedRunningTurn(entry)) {
      continue;
    }
    scheduleThreadDetailGapRefresh(entry);
  }
}

function scheduleThreadDetailGapRefresh(entry: ThreadDetailSubscriptionEntry): void {
  // Use the same short debounce as scheduleThreadDetailRefreshIfBehind so
  // multiple resume signals coalesce into one refresh.
  if (entry.refreshTimeoutId !== null) {
    return;
  }
  entry.refreshTimeoutId = setTimeout(() => {
    entry.refreshTimeoutId = null;
    const current = threadDetailSubscriptions.get(
      getThreadDetailSubscriptionKey(entry.environmentId, entry.threadId),
    );
    if (!current) {
      return;
    }
    refreshThreadDetailSubscription(current);
  }, THREAD_DETAIL_REFRESH_AFTER_SHELL_ADVANCE_MS);
}

function shouldRefreshRetainedThreadDetailSubscription(entry: ThreadDetailSubscriptionEntry) {
  return entry.refCount > 0 || isNonIdleThreadDetailSubscription(entry);
}

function shouldActivelyReconcileThreadDetailSubscription(
  entry: ThreadDetailSubscriptionEntry,
): boolean {
  return entry.refCount > 0 && isNonIdleThreadDetailSubscription(entry);
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
        if (
          entry.latestDetailSequence !== null &&
          item.snapshot.snapshotSequence < entry.latestDetailSequence
        ) {
          return;
        }
        markThreadDetailSequence(entry, item.snapshot.snapshotSequence);
        useStore.getState().syncServerThreadDetail(item.snapshot.thread, entry.environmentId, {
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

function refreshThreadDetailSubscription(entry: ThreadDetailSubscriptionEntry): boolean {
  clearThreadDetailSubscriptionRefresh(entry);
  if (entry.unsubscribe !== NOOP) {
    entry.unsubscribe();
    entry.unsubscribe = NOOP;
  }

  if (attachThreadDetailSubscription(entry)) {
    return true;
  }

  watchThreadDetailSubscriptionConnection(entry);
  return false;
}

function scheduleThreadDetailRefreshIfBehind(
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

  if (entry.latestDetailSequence !== null && entry.latestDetailSequence >= sequence) {
    return;
  }

  if (entry.refreshTargetSequence !== null && entry.refreshTargetSequence >= sequence) {
    return;
  }

  if (entry.refreshTimeoutId !== null) {
    clearTimeout(entry.refreshTimeoutId);
  }
  entry.refreshTargetSequence = sequence;
  entry.refreshTimeoutId = setTimeout(() => {
    entry.refreshTimeoutId = null;
    const targetSequence = entry.refreshTargetSequence;
    entry.refreshTargetSequence = null;
    if (targetSequence === null) {
      return;
    }
    if (entry.latestDetailSequence !== null && entry.latestDetailSequence >= targetSequence) {
      return;
    }
    refreshThreadDetailSubscription(entry);
  }, THREAD_DETAIL_REFRESH_AFTER_SHELL_ADVANCE_MS);
}

function scheduleThreadDetailRefreshToCurrentProjectionIfBehind(
  entry: ThreadDetailSubscriptionEntry,
): void {
  const currentProjectionSequence = readLastAppliedProjectionVersion(entry.environmentId)?.sequence;
  if (currentProjectionSequence === undefined) {
    return;
  }
  scheduleThreadDetailRefreshIfBehind(
    entry.environmentId,
    entry.threadId,
    currentProjectionSequence,
  );
}

function reconcileActiveThreadDetailSubscription(entry: ThreadDetailSubscriptionEntry): void {
  const connection = readEnvironmentConnection(entry.environmentId);
  if (connection) {
    queueEnvironmentBrowserResumeReconciliation(connection, "active-thread-detail");
  }
  scheduleThreadDetailRefreshToCurrentProjectionIfBehind(entry);
}

function reconcileThreadDetailSubscriptionActiveReconcileState(
  entry: ThreadDetailSubscriptionEntry,
): void {
  if (!shouldActivelyReconcileThreadDetailSubscription(entry)) {
    clearThreadDetailSubscriptionActiveReconcile(entry);
    return;
  }

  if (entry.activeReconcileIntervalId !== null) {
    return;
  }

  entry.activeReconcileIntervalId = setInterval(() => {
    const currentEntry = threadDetailSubscriptions.get(
      getThreadDetailSubscriptionKey(entry.environmentId, entry.threadId),
    );
    if (!currentEntry) {
      return;
    }
    if (!shouldActivelyReconcileThreadDetailSubscription(currentEntry)) {
      clearThreadDetailSubscriptionActiveReconcile(currentEntry);
      return;
    }
    reconcileActiveThreadDetailSubscription(currentEntry);
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

  clearThreadDetailSubscriptionRefresh(entry);
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

export function retainThreadDetailSubscription(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): () => void {
  const key = getThreadDetailSubscriptionKey(environmentId, threadId);
  const existing = threadDetailSubscriptions.get(key);
  if (existing) {
    clearThreadDetailSubscriptionEviction(existing);
    existing.refCount += 1;
    existing.lastAccessedAt = Date.now();
    if (!attachThreadDetailSubscription(existing)) {
      watchThreadDetailSubscriptionConnection(existing);
    }
    scheduleThreadDetailRefreshToCurrentProjectionIfBehind(existing);
    reconcileThreadDetailSubscriptionEvictionState(existing);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      existing.refCount = Math.max(0, existing.refCount - 1);
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
    latestDetailSequence: null,
    refreshTargetSequence: null,
    refreshTimeoutId: null,
    activeReconcileIntervalId: null,
    lastAccessedAt: Date.now(),
    evictionTimeoutId: null,
  };
  threadDetailSubscriptions.set(key, entry);
  if (!attachThreadDetailSubscription(entry)) {
    watchThreadDetailSubscriptionConnection(entry);
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
    entry.lastAccessedAt = Date.now();
    reconcileThreadDetailSubscriptionEvictionState(entry);
    evictIdleThreadDetailSubscriptionsToCapacity();
  };
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
) {
  applyRecoveredEventBatch([event], environmentId, {
    preserveShellFields: shouldPreserveThreadDetailShellFields(environmentId, event.sequence),
  });
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
      scheduleThreadDetailRefreshIfBehind(environmentId, event.thread.id, event.sequence);
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
): Promise<void> {
  const environmentId = connection.environmentId;

  // Fast path: if the heartbeat pong is stale, the underlying socket is
  // almost certainly dead (common on iOS PWA after backgrounding, where
  // the JS `WebSocket` may still report OPEN even though TCP is gone).
  // Skip the probe round-trip and reconnect immediately so thread detail
  // subscriptions re-attach on the new session.
  if (!connection.client.isHeartbeatFresh()) {
    console.warn("Environment heartbeat stale on browser resume; reconnecting", {
      environmentId,
      reason,
    });
    await connection.reconnect();
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
    if (readEnvironmentConnection(environmentId) !== connection) {
      return;
    }
    const latestSequenceAfterProbe =
      readLastAppliedProjectionVersion(environmentId)?.sequence ?? currentSequence;
    if (!syncProbe.behind || syncProbe.serverSequence <= latestSequenceAfterProbe) {
      // Even when sequences align, a thread may be parked in the gap state
      // where session.activeTurnId still names a turn that latestTurn marks
      // completed — typically because the closing thread.session-set was
      // dropped while iOS backgrounded the tab. Re-fetch the affected thread
      // detail subscription(s) so the store converges to the server snapshot.
      refreshThreadDetailSubscriptionsStuckOnCompletedRunningTurn(environmentId);
      return;
    }

    const replayedEvents = await withTimeout(
      connection.client.orchestration.replayEvents({
        fromSequenceExclusive: latestSequenceAfterProbe,
      }),
      BROWSER_RESUME_RECONCILE_TIMEOUT_MS,
      () => new Error("Browser resume replay timed out."),
    );
    if (readEnvironmentConnection(environmentId) !== connection) {
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
    refreshThreadDetailSubscriptionsStuckOnCompletedRunningTurn(environmentId);
  } catch (error) {
    if (readEnvironmentConnection(environmentId) !== connection) {
      return;
    }

    console.warn("Environment reconciliation after browser resume failed; reconnecting", {
      environmentId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    await connection.reconnect();
  }
}

function queueEnvironmentBrowserResumeReconciliation(
  connection: EnvironmentConnection,
  reason: string,
): void {
  const environmentId = connection.environmentId;
  if (browserResumeReconciliationByEnvironment.has(environmentId)) {
    return;
  }

  const promise = reconcileEnvironmentConnectionAfterBrowserResume(connection, reason).catch(
    (error) => {
      console.warn("Environment reconnect after browser resume failed", {
        environmentId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );

  browserResumeReconciliationByEnvironment.set(environmentId, promise);
  void promise.finally(() => {
    if (browserResumeReconciliationByEnvironment.get(environmentId) === promise) {
      browserResumeReconciliationByEnvironment.delete(environmentId);
    }
  });
}

function reconcileEnvironmentConnectionsAfterBrowserResume(reason: string): void {
  const now = Date.now();
  if (now - lastBrowserResumeReconcileAt < BROWSER_RESUME_RECONCILE_COOLDOWN_MS) {
    return;
  }
  lastBrowserResumeReconcileAt = now;

  for (const connection of environmentConnections.values()) {
    queueEnvironmentBrowserResumeReconciliation(connection, reason);
  }
}

function subscribeBrowserResumeReconnects(): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return NOOP;
  }

  const handleVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      lastBrowserHiddenAt = Date.now();
      return;
    }
    if (document.visibilityState === "visible" && lastBrowserHiddenAt !== null) {
      lastBrowserHiddenAt = null;
      reconcileEnvironmentConnectionsAfterBrowserResume("visibilitychange");
    }
  };

  const handlePageHide = () => {
    lastBrowserHiddenAt = Date.now();
  };

  const handlePageShow = (event: PageTransitionEvent) => {
    const hadPriorBackgroundSignal = lastBrowserHiddenAt !== null;
    const shouldReconcile =
      event.persisted || hadPriorBackgroundSignal || hasRetainedThreadDetailSubscription();
    lastBrowserHiddenAt = null;
    if (shouldReconcile) {
      reconcileEnvironmentConnectionsAfterBrowserResume(
        event.persisted
          ? "pageshow:bfcache"
          : hadPriorBackgroundSignal
            ? "pageshow"
            : "pageshow:visible",
      );
    }
  };

  const handleWindowFocus = () => {
    if (document.visibilityState !== "visible") {
      return;
    }
    const hadPriorBackgroundSignal = lastBrowserHiddenAt !== null;
    if (!hadPriorBackgroundSignal && !hasRetainedThreadDetailSubscription()) {
      return;
    }
    lastBrowserHiddenAt = null;
    reconcileEnvironmentConnectionsAfterBrowserResume(
      hadPriorBackgroundSignal ? "focus" : "focus:visible",
    );
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pagehide", handlePageHide);
  window.addEventListener("pageshow", handlePageShow);
  window.addEventListener("focus", handleWindowFocus);
  return () => {
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
  lastBrowserResumeReconcileAt = Number.NEGATIVE_INFINITY;
  browserResumeReconciliationByEnvironment.clear();
  lastAppliedProjectionVersionByEnvironment.clear();
  projectionRecoveryByEnvironment.clear();
  pendingSavedEnvironmentConnections.clear();
  for (const key of Array.from(threadDetailSubscriptions.keys())) {
    disposeThreadDetailSubscriptionByKey(key);
  }
  await Promise.all(
    [...environmentConnections.keys()].map((environmentId) => removeConnection(environmentId)),
  );
}
