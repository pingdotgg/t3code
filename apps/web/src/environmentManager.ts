import {
  type EnvironmentId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type TerminalEvent,
  ThreadId,
} from "@t3tools/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { Throttler } from "@tanstack/react-pacer";
import {
  createKnownEnvironmentFromWsUrl,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime";

import {
  markPromotedDraftThreadByRef,
  markPromotedDraftThreadsByRef,
  useComposerDraftStore,
} from "./composerDraftStore";
import { deriveOrchestrationBatchEffects } from "./orchestrationEventEffects";
import {
  createWsRpcClient,
  ensureWsRpcClientEntryForKnownEnvironment,
  getPrimaryWsRpcClientEntry,
  bindWsRpcClientEntryEnvironment,
  listWsRpcClientEntries,
  readWsRpcClientEntryForEnvironment,
  registerWsRpcClientEntry,
  removeWsRpcClientEntry,
  subscribeWsRpcClientRegistry,
  type WsRpcClientEntry,
} from "./wsRpcClient";
import { providerQueryKeys } from "./lib/providerReactQuery";
import { projectQueryKeys } from "./lib/projectReactQuery";
import {
  getSavedEnvironmentRecord,
  listSavedEnvironmentRecords,
  type SavedEnvironmentRecord,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "./savedEnvironmentsStore";
import {
  selectProjectsAcrossEnvironments,
  selectThreadByRef,
  selectThreadsAcrossEnvironments,
  useStore,
} from "./store";
import { collectActiveTerminalThreadIds } from "./lib/terminalStateCleanup";
import { useTerminalStateStore } from "./terminalStateStore";
import { useUiStateStore } from "./uiStateStore";
import {
  createOrchestrationRecoveryCoordinator,
  deriveReplayRetryDecision,
  type OrchestrationRecoveryReason,
  type ReplayRetryTracker,
} from "./orchestrationRecovery";
import type { AuthSessionRole, ServerConfig } from "@t3tools/contracts";
import {
  bootstrapRemoteBearerSession,
  fetchRemoteSessionState,
  resolveRemotePairingTarget,
  resolveRemoteWebSocketConnectionUrl,
} from "./remoteEnvironmentAuth";
import { WsTransport } from "./wsTransport";

const REPLAY_RECOVERY_RETRY_DELAY_MS = 100;
const MAX_NO_PROGRESS_REPLAY_RETRIES = 3;

/**
 * Runtime owner for environment connectivity in the web app.
 *
 * Responsibilities collected here:
 * - materialize the local environment plus all saved remote environments
 * - keep one websocket client per environment entry
 * - attach orchestration/server/terminal subscriptions for each client
 * - bootstrap snapshot + replay recovery
 * - project remote state directly into Zustand stores
 *
 * React should only start/stop this manager and handle UI-only concerns such as
 * navigation and toasts.
 */
interface OrchestrationRegistryHandlers {
  readonly applyEventBatch: (
    events: ReadonlyArray<OrchestrationEvent>,
    environmentId: EnvironmentId,
  ) => void;
  readonly syncSnapshot: (snapshot: OrchestrationReadModel, environmentId: EnvironmentId) => void;
  readonly applyTerminalEvent: (event: TerminalEvent, environmentId: EnvironmentId) => void;
}

/**
 * Minimal adapter over the websocket client registry so the orchestration
 * controller can be tested without the full app runtime.
 */
interface RegistryAdapter {
  readonly listEntries: () => ReadonlyArray<WsRpcClientEntry>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly bindEnvironment: (entryKey: string, environmentId: EnvironmentId) => void;
}

/**
 * Registry-level orchestrator for per-client subscriptions and recovery.
 *
 * There is one controller per running app shell. It observes registry changes
 * and ensures every websocket client entry has one matching client context.
 */
interface OrchestrationRegistrySyncController {
  readonly bindClientEnvironment: (
    entryKey: string,
    environmentId: EnvironmentId,
    options?: { readonly ensureSnapshot?: boolean },
  ) => void;
  readonly ensureSnapshotRecoveryForEnvironment: (environmentId: EnvironmentId) => Promise<void>;
  readonly dispose: () => void;
}

/**
 * Per-client orchestration lifecycle state.
 *
 * A context owns snapshot bootstrap, replay recovery, event buffering, and
 * subscription cleanup for exactly one websocket client entry.
 */
interface ClientContext {
  readonly key: string;
  readonly getBoundEnvironmentId: () => EnvironmentId | null;
  readonly bindEnvironmentId: (
    environmentId: EnvironmentId,
    options?: { readonly ensureSnapshot?: boolean },
  ) => void;
  readonly ensureSnapshotRecovery: (
    reason: Extract<OrchestrationRecoveryReason, "bootstrap" | "replay-failed">,
    environmentId: EnvironmentId,
  ) => Promise<void>;
  readonly syncEntry: (entry: WsRpcClientEntry) => void;
  readonly cleanup: () => void;
}

const defaultRegistryAdapter: RegistryAdapter = {
  listEntries: listWsRpcClientEntries,
  subscribe: subscribeWsRpcClientRegistry,
  bindEnvironment: bindWsRpcClientEntryEnvironment,
};

/**
 * Deduplicates overlapping "ensure snapshot" requests for a single client.
 *
 * Multiple triggers can legitimately race during startup and reconnects:
 * welcome events, config snapshots, registry hydration, or explicit bootstrap
 * calls from the root route. This keeps them collapsed to one in-flight fetch.
 */
export function createSnapshotBootstrapController(input: {
  readonly isBootstrapped: () => boolean;
  readonly getBoundEnvironmentId: () => EnvironmentId | null;
  readonly runSnapshotRecovery: (
    reason: Extract<OrchestrationRecoveryReason, "bootstrap" | "replay-failed">,
    environmentId: EnvironmentId,
  ) => Promise<void>;
}) {
  let inFlight: Promise<void> | null = null;

  return {
    ensureSnapshotRecovery(
      reason: Extract<OrchestrationRecoveryReason, "bootstrap" | "replay-failed">,
      environmentId: EnvironmentId,
    ): Promise<void> {
      if (
        inFlight === null &&
        input.isBootstrapped() &&
        input.getBoundEnvironmentId() === environmentId
      ) {
        return Promise.resolve();
      }

      if (inFlight !== null) {
        return inFlight;
      }

      inFlight = input.runSnapshotRecovery(reason, environmentId).finally(() => {
        inFlight = null;
      });

      return inFlight;
    },
  };
}

/**
 * Builds the orchestration controller for one websocket client entry.
 *
 * Both local and remote environments flow through this exact path so the rules
 * for subscription setup, snapshot bootstrap, and replay recovery stay uniform.
 */
function createClientContext(
  entry: WsRpcClientEntry,
  handlers: OrchestrationRegistryHandlers,
  registry: RegistryAdapter,
): ClientContext {
  const recovery = createOrchestrationRecoveryCoordinator();
  let replayRetryTracker: ReplayRetryTracker | null = null;
  const pendingDomainEvents: OrchestrationEvent[] = [];
  let flushPendingDomainEventsScheduled = false;
  let boundEnvironmentId = entry.environmentId;
  let disposed = false;

  const flushPendingDomainEvents = () => {
    flushPendingDomainEventsScheduled = false;
    if (disposed || pendingDomainEvents.length === 0 || boundEnvironmentId === null) {
      return;
    }

    const events = pendingDomainEvents.splice(0, pendingDomainEvents.length);
    const nextEvents = recovery.markEventBatchApplied(events);
    if (nextEvents.length === 0) {
      return;
    }
    handlers.applyEventBatch(nextEvents, boundEnvironmentId);
  };

  const schedulePendingDomainEventFlush = () => {
    if (flushPendingDomainEventsScheduled) {
      return;
    }

    flushPendingDomainEventsScheduled = true;
    queueMicrotask(flushPendingDomainEvents);
  };

  const runReplayRecovery = async (reason: "sequence-gap" | "resubscribe"): Promise<void> => {
    if (!recovery.beginReplayRecovery(reason)) {
      return;
    }

    const fromSequenceExclusive = recovery.getState().latestSequence;
    try {
      const events = await entry.client.orchestration.replayEvents({ fromSequenceExclusive });
      if (!disposed) {
        if (boundEnvironmentId === null) {
          replayRetryTracker = null;
          recovery.failReplayRecovery();
          return;
        }
        const nextEvents = recovery.markEventBatchApplied(events);
        if (nextEvents.length > 0) {
          handlers.applyEventBatch(nextEvents, boundEnvironmentId);
        }
      }
    } catch {
      replayRetryTracker = null;
      recovery.failReplayRecovery();
      if (boundEnvironmentId !== null) {
        await snapshotBootstrap.ensureSnapshotRecovery("replay-failed", boundEnvironmentId);
      }
      return;
    }

    if (!disposed) {
      const replayCompletion = recovery.completeReplayRecovery();
      const retryDecision = deriveReplayRetryDecision({
        previousTracker: replayRetryTracker,
        completion: replayCompletion,
        recoveryState: recovery.getState(),
        baseDelayMs: REPLAY_RECOVERY_RETRY_DELAY_MS,
        maxNoProgressRetries: MAX_NO_PROGRESS_REPLAY_RETRIES,
      });
      replayRetryTracker = retryDecision.tracker;

      if (retryDecision.shouldRetry) {
        if (retryDecision.delayMs > 0) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, retryDecision.delayMs);
          });
          if (disposed) {
            return;
          }
        }
        void runReplayRecovery(reason);
      } else if (replayCompletion.shouldReplay && import.meta.env.MODE !== "test") {
        console.warn(
          "[orchestration-recovery]",
          "Stopping replay recovery after no-progress retries.",
          {
            entryKey: entry.key,
            environmentId: boundEnvironmentId,
            state: recovery.getState(),
          },
        );
      }
    }
  };

  const runSnapshotRecovery = async (
    reason: Extract<OrchestrationRecoveryReason, "bootstrap" | "replay-failed">,
    environmentId: EnvironmentId,
  ): Promise<void> => {
    const started = recovery.beginSnapshotRecovery(reason);
    if (import.meta.env.MODE !== "test") {
      const state = recovery.getState();
      console.info("[orchestration-recovery]", "Snapshot recovery requested.", {
        reason,
        entryKey: entry.key,
        environmentId,
        skipped: !started,
        ...(started
          ? {}
          : {
              blockedBy: state.inFlight?.kind ?? null,
              blockedByReason: state.inFlight?.reason ?? null,
            }),
        state,
      });
    }
    if (!started) {
      return;
    }

    try {
      const snapshot = await entry.client.orchestration.getSnapshot();
      if (!disposed) {
        bindEnvironmentId(environmentId, { ensureSnapshot: false });
        handlers.syncSnapshot(snapshot, environmentId);
        if (recovery.completeSnapshotRecovery(snapshot.snapshotSequence)) {
          void runReplayRecovery("sequence-gap");
        }
      }
    } catch {
      recovery.failSnapshotRecovery();
    }
  };

  const snapshotBootstrap = createSnapshotBootstrapController({
    isBootstrapped: () => recovery.getState().bootstrapped,
    getBoundEnvironmentId: () => boundEnvironmentId,
    runSnapshotRecovery,
  });

  const bindEnvironmentId = (
    environmentId: EnvironmentId,
    options?: { readonly ensureSnapshot?: boolean },
  ) => {
    if (boundEnvironmentId !== environmentId) {
      boundEnvironmentId = environmentId;
      registry.bindEnvironment(entry.key, environmentId);
      schedulePendingDomainEventFlush();
    }

    if (options?.ensureSnapshot ?? true) {
      void snapshotBootstrap.ensureSnapshotRecovery("bootstrap", environmentId);
    }
  };

  const unsubLifecycle = entry.client.server.subscribeLifecycle((event) => {
    if (event.type === "welcome") {
      bindEnvironmentId(event.payload.environment.environmentId);
    }
  });

  const unsubConfig = entry.client.server.subscribeConfig((event) => {
    if (event.type === "snapshot") {
      bindEnvironmentId(event.config.environment.environmentId);
    }
  });

  if (boundEnvironmentId !== null) {
    bindEnvironmentId(boundEnvironmentId);
  } else {
    void entry.client.server
      .getConfig()
      .then((config) => {
        if (!disposed) {
          bindEnvironmentId(config.environment.environmentId);
        }
      })
      .catch(() => undefined);
  }

  const unsubDomainEvent = entry.client.orchestration.onDomainEvent(
    (event) => {
      const action = recovery.classifyDomainEvent(event.sequence);
      if (action === "apply") {
        pendingDomainEvents.push(event);
        schedulePendingDomainEventFlush();
        return;
      }
      if (action === "recover") {
        flushPendingDomainEvents();
        void runReplayRecovery("sequence-gap");
      }
    },
    {
      onResubscribe: () => {
        if (disposed) {
          return;
        }
        flushPendingDomainEvents();
        void runReplayRecovery("resubscribe");
      },
    },
  );

  const unsubTerminalEvent = entry.client.terminal.onEvent((event) => {
    if (boundEnvironmentId === null) {
      return;
    }
    handlers.applyTerminalEvent(event, boundEnvironmentId);
  });

  return {
    key: entry.key,
    getBoundEnvironmentId: () => boundEnvironmentId,
    bindEnvironmentId,
    ensureSnapshotRecovery: snapshotBootstrap.ensureSnapshotRecovery,
    syncEntry: (nextEntry) => {
      if (nextEntry.environmentId === null) {
        boundEnvironmentId = null;
        return;
      }
      bindEnvironmentId(nextEntry.environmentId);
    },
    cleanup: () => {
      disposed = true;
      flushPendingDomainEventsScheduled = false;
      pendingDomainEvents.length = 0;
      unsubDomainEvent();
      unsubTerminalEvent();
      unsubLifecycle();
      unsubConfig();
    },
  };
}

/**
 * Tracks the websocket registry and attaches/detaches one client context per
 * registered entry.
 */
export function createOrchestrationRegistrySyncController(
  handlers: OrchestrationRegistryHandlers,
  registry: RegistryAdapter = defaultRegistryAdapter,
): OrchestrationRegistrySyncController {
  const contexts = new Map<string, ClientContext>();

  const syncRegistry = () => {
    const entries = registry.listEntries();
    const nextKeys = new Set(entries.map((entry) => entry.key));

    for (const [key, context] of contexts.entries()) {
      if (!nextKeys.has(key)) {
        context.cleanup();
        contexts.delete(key);
      }
    }

    for (const entry of entries) {
      const existingContext = contexts.get(entry.key);
      if (existingContext) {
        existingContext.syncEntry(entry);
        continue;
      }
      contexts.set(entry.key, createClientContext(entry, handlers, registry));
    }
  };

  const unsubscribe = registry.subscribe(syncRegistry);
  syncRegistry();

  return {
    bindClientEnvironment: (entryKey, environmentId, options) => {
      const context = contexts.get(entryKey);
      if (!context) {
        registry.bindEnvironment(entryKey, environmentId);
        return;
      }
      context.bindEnvironmentId(environmentId, options);
    },
    ensureSnapshotRecoveryForEnvironment: async (environmentId) => {
      const context = [...contexts.values()].find(
        (candidate) => candidate.getBoundEnvironmentId() === environmentId,
      );
      if (!context) {
        return;
      }
      await context.ensureSnapshotRecovery("bootstrap", environmentId);
    },
    dispose: () => {
      unsubscribe();
      for (const context of contexts.values()) {
        context.cleanup();
      }
      contexts.clear();
    },
  };
}

function startOrchestrationRegistrySync(
  handlers: OrchestrationRegistryHandlers,
): OrchestrationRegistrySyncController {
  return createOrchestrationRegistrySyncController(handlers);
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

function reconcileSnapshotDerivedState() {
  const storeState = useStore.getState();
  const threads = selectThreadsAcrossEnvironments(storeState);
  const projects = selectProjectsAcrossEnvironments(storeState);

  useUiStateStore.getState().syncProjects(
    projects.map((project) => ({
      key: scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
      cwd: project.cwd,
    })),
  );
  useUiStateStore.getState().syncThreads(
    threads.map((thread) => ({
      key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      seedVisitedAt: thread.updatedAt ?? thread.createdAt,
    })),
  );
  markPromotedDraftThreadsByRef(
    threads.map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
  );

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

function applyRecoveredEventBatch(
  events: ReadonlyArray<OrchestrationEvent>,
  environmentId: EnvironmentId,
  queryInvalidationThrottler: Throttler<() => void>,
  setNeedsProviderInvalidation: (next: boolean) => void,
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
    setNeedsProviderInvalidation(true);
    void queryInvalidationThrottler.maybeExecute();
  }

  useStore.getState().applyOrchestrationEvents(uiEvents, environmentId);
  if (needsProjectUiSync) {
    const projects = selectProjectsAcrossEnvironments(useStore.getState());
    useUiStateStore.getState().syncProjects(
      projects.map((project) => ({
        key: scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
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
    draftStore.clearDraftThread(scopeThreadRef(environmentId, threadId));
    useUiStateStore
      .getState()
      .clearThreadUi(scopedThreadKey(scopeThreadRef(environmentId, threadId)));
  }
  for (const threadId of batchEffects.removeTerminalStateThreadIds) {
    useTerminalStateStore.getState().removeTerminalState(scopeThreadRef(environmentId, threadId));
  }
}

type EnvironmentConnectionManager = {
  readonly ensureEnvironmentBootstrapped: (environmentId: EnvironmentId) => Promise<void>;
  readonly bindPrimaryEnvironment: (environmentId: EnvironmentId) => void;
  readonly stop: () => void;
};

/**
 * Persisted remote environments are only desired state. This interface
 * represents one currently materialized remote connection in the running app.
 */
type ActiveSavedEnvironmentConnection = {
  readonly entryKey: string;
  readonly client: ReturnType<typeof createWsRpcClient>;
  readonly cleanup: () => void;
  readonly refreshMetadata: () => Promise<void>;
};

const activeSavedEnvironmentConnections = new Map<
  EnvironmentId,
  ActiveSavedEnvironmentConnection
>();

function isoNow(): string {
  return new Date().toISOString();
}

function getRuntimeErrorFields(error: unknown) {
  return {
    lastError: error instanceof Error ? error.message : String(error),
    lastErrorAt: isoNow(),
  } as const;
}

function setRuntimeConnecting(environmentId: EnvironmentId) {
  useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
    connectionState: "connecting",
    lastError: null,
    lastErrorAt: null,
  });
}

function setRuntimeConnected(environmentId: EnvironmentId) {
  useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
    connectionState: "connected",
    authState: "authenticated",
    connectedAt: isoNow(),
    disconnectedAt: null,
    lastError: null,
    lastErrorAt: null,
  });
  useSavedEnvironmentRegistryStore.getState().markConnected(environmentId, isoNow());
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

async function refreshSavedEnvironmentMetadata(
  record: SavedEnvironmentRecord,
  client: ReturnType<typeof createWsRpcClient>,
  roleHint?: AuthSessionRole | null,
  configHint?: ServerConfig | null,
): Promise<void> {
  const [serverConfig, sessionState] = await Promise.all([
    configHint ? Promise.resolve(configHint) : client.server.getConfig(),
    fetchRemoteSessionState({
      httpBaseUrl: record.httpBaseUrl,
      bearerToken: record.bearerToken,
    }),
  ]);

  useSavedEnvironmentRuntimeStore.getState().patch(record.environmentId, {
    authState: sessionState.authenticated ? "authenticated" : "requires-auth",
    descriptor: serverConfig.environment,
    serverConfig,
    role: sessionState.authenticated ? (sessionState.role ?? roleHint ?? null) : null,
  });
}

function createSavedEnvironmentClient(record: SavedEnvironmentRecord) {
  useSavedEnvironmentRuntimeStore.getState().ensure(record.environmentId);

  return createWsRpcClient(
    new WsTransport(
      () =>
        resolveRemoteWebSocketConnectionUrl({
          wsBaseUrl: record.wsBaseUrl,
          httpBaseUrl: record.httpBaseUrl,
          bearerToken: record.bearerToken,
        }),
      {
        onAttempt: () => {
          setRuntimeConnecting(record.environmentId);
        },
        onOpen: () => {
          setRuntimeConnected(record.environmentId);
        },
        onError: (message) => {
          useSavedEnvironmentRuntimeStore.getState().patch(record.environmentId, {
            connectionState: "error",
            lastError: message,
            lastErrorAt: isoNow(),
          });
        },
        onClose: (details) => {
          setRuntimeDisconnected(record.environmentId, details.reason);
        },
      },
    ),
  );
}

/**
 * Materializes one saved-environment record into an active websocket client and
 * wires the lightweight server-metadata subscriptions used by the settings UI.
 *
 * Orchestration subscriptions are intentionally not attached here; those are
 * owned by the registry-level orchestration controller above.
 */
async function ensureSavedEnvironmentConnection(
  record: SavedEnvironmentRecord,
  options?: {
    readonly client?: ReturnType<typeof createWsRpcClient>;
    readonly role?: AuthSessionRole | null;
    readonly serverConfig?: ServerConfig | null;
  },
): Promise<void> {
  if (activeSavedEnvironmentConnections.has(record.environmentId)) {
    return;
  }

  const existingEntry = readWsRpcClientEntryForEnvironment(record.environmentId);
  if (existingEntry && existingEntry.key !== record.environmentId) {
    useSavedEnvironmentRuntimeStore.getState().patch(record.environmentId, {
      connectionState: "error",
      lastError: "This environment is already connected elsewhere in the app.",
      lastErrorAt: isoNow(),
      authState: "unknown",
    });
    return;
  }

  const client = options?.client ?? createSavedEnvironmentClient(record);
  const knownEnvironment = createKnownEnvironmentFromWsUrl({
    id: record.environmentId,
    label: record.label,
    source: "manual",
    wsUrl: record.wsBaseUrl,
  });

  let removedOnFailure = false;
  try {
    const entry = registerWsRpcClientEntry({
      key: record.environmentId,
      knownEnvironment: {
        ...knownEnvironment,
        environmentId: record.environmentId,
      },
      client,
      environmentId: record.environmentId,
    });

    let nextRoleHint = options?.role ?? null;
    let nextServerConfigHint = options?.serverConfig ?? null;
    const refreshMetadata = async () => {
      const roleHint = nextRoleHint;
      const serverConfigHint = nextServerConfigHint;
      nextRoleHint = null;
      nextServerConfigHint = null;
      await refreshSavedEnvironmentMetadata(record, client, roleHint, serverConfigHint);
    };

    const unsubscribeConfig = client.server.subscribeConfig((event) => {
      if (event.type !== "snapshot") {
        return;
      }
      useSavedEnvironmentRuntimeStore.getState().patch(record.environmentId, {
        descriptor: event.config.environment,
        serverConfig: event.config,
      });
    });

    const unsubscribeLifecycle = client.server.subscribeLifecycle((event) => {
      if (event.type !== "welcome") {
        return;
      }
      useSavedEnvironmentRuntimeStore.getState().patch(record.environmentId, {
        descriptor: event.payload.environment,
      });
    });

    activeSavedEnvironmentConnections.set(record.environmentId, {
      entryKey: entry.key,
      client,
      cleanup: () => {
        unsubscribeConfig();
        unsubscribeLifecycle();
      },
      refreshMetadata,
    });

    await refreshMetadata();
  } catch (error) {
    setRuntimeError(record.environmentId, error);
    if (activeSavedEnvironmentConnections.has(record.environmentId)) {
      const active = activeSavedEnvironmentConnections.get(record.environmentId);
      activeSavedEnvironmentConnections.delete(record.environmentId);
      active?.cleanup();
    } else {
      await client.dispose().catch(() => undefined);
    }

    if (readWsRpcClientEntryForEnvironment(record.environmentId)?.key === record.environmentId) {
      removedOnFailure = await removeWsRpcClientEntry(record.environmentId);
    }

    if (!removedOnFailure) {
      await removeWsRpcClientEntry(record.environmentId).catch(() => false);
    }
    throw error;
  }
}

/**
 * Reconciles the persisted remote-environment registry with the active runtime
 * connection map.
 */
async function syncSavedEnvironmentConnections(
  records: ReadonlyArray<SavedEnvironmentRecord>,
): Promise<void> {
  const expectedEnvironmentIds = new Set(records.map((record) => record.environmentId));
  const staleEnvironmentIds = [...activeSavedEnvironmentConnections.keys()].filter(
    (environmentId) => !expectedEnvironmentIds.has(environmentId),
  );

  await Promise.all(
    staleEnvironmentIds.map((environmentId) => disconnectSavedEnvironment(environmentId)),
  );
  await Promise.all(
    records.map((record) => ensureSavedEnvironmentConnection(record).catch(() => undefined)),
  );
}

export async function disconnectSavedEnvironment(environmentId: EnvironmentId): Promise<void> {
  const active = activeSavedEnvironmentConnections.get(environmentId);
  activeSavedEnvironmentConnections.delete(environmentId);
  active?.cleanup();
  useSavedEnvironmentRuntimeStore.getState().clear(environmentId);
  await removeWsRpcClientEntry(environmentId).catch(() => false);
}

export async function reconnectSavedEnvironment(environmentId: EnvironmentId): Promise<void> {
  const record = getSavedEnvironmentRecord(environmentId);
  if (!record) {
    throw new Error("Saved environment not found.");
  }

  const active = activeSavedEnvironmentConnections.get(environmentId);
  if (!active) {
    await ensureSavedEnvironmentConnection(record);
    return;
  }

  setRuntimeConnecting(environmentId);
  try {
    await active.client.reconnect();
    useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
      connectionState: "connected",
      disconnectedAt: null,
      lastError: null,
      lastErrorAt: null,
    });
  } catch (error) {
    setRuntimeError(environmentId, error);
    throw error;
  }

  try {
    await active.refreshMetadata();
  } catch (error) {
    useSavedEnvironmentRuntimeStore.getState().patch(environmentId, {
      ...getRuntimeErrorFields(error),
    });
    throw error;
  }
}

export async function removeSavedEnvironment(environmentId: EnvironmentId): Promise<void> {
  useSavedEnvironmentRegistryStore.getState().remove(environmentId);
  await disconnectSavedEnvironment(environmentId);
}

export async function addSavedEnvironment(input: {
  readonly label: string;
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
}): Promise<SavedEnvironmentRecord> {
  const resolvedTarget = resolveRemotePairingTarget({
    ...(input.pairingUrl !== undefined ? { pairingUrl: input.pairingUrl } : {}),
    ...(input.host !== undefined ? { host: input.host } : {}),
    ...(input.pairingCode !== undefined ? { pairingCode: input.pairingCode } : {}),
  });
  const bearerSession = await bootstrapRemoteBearerSession({
    httpBaseUrl: resolvedTarget.httpBaseUrl,
    credential: resolvedTarget.credential,
  });
  const temporaryClient = createWsRpcClient(
    new WsTransport(() =>
      resolveRemoteWebSocketConnectionUrl({
        wsBaseUrl: resolvedTarget.wsBaseUrl,
        httpBaseUrl: resolvedTarget.httpBaseUrl,
        bearerToken: bearerSession.sessionToken,
      }),
    ),
  );

  try {
    const serverConfig = await temporaryClient.server.getConfig();
    const environmentId = serverConfig.environment.environmentId;

    if (readWsRpcClientEntryForEnvironment(environmentId)) {
      throw new Error("This environment is already connected.");
    }

    const record: SavedEnvironmentRecord = {
      environmentId,
      label: input.label.trim() || serverConfig.environment.label,
      wsBaseUrl: resolvedTarget.wsBaseUrl,
      httpBaseUrl: resolvedTarget.httpBaseUrl,
      bearerToken: bearerSession.sessionToken,
      createdAt: isoNow(),
      lastConnectedAt: isoNow(),
    };

    await temporaryClient.dispose().catch(() => undefined);
    await ensureSavedEnvironmentConnection(record, {
      client: createSavedEnvironmentClient(record),
      role: bearerSession.role,
      serverConfig,
    });
    useSavedEnvironmentRegistryStore.getState().upsert(record);
    return record;
  } catch (error) {
    await temporaryClient.dispose().catch(() => undefined);
    throw error;
  }
}

function syncSavedEnvironmentConnectionsFromStore(): Promise<void> {
  return syncSavedEnvironmentConnections(listSavedEnvironmentRecords());
}

export async function resetSavedEnvironmentConnectionsForTests(): Promise<void> {
  await Promise.all(
    [...activeSavedEnvironmentConnections.keys()].map((environmentId) =>
      disconnectSavedEnvironment(environmentId),
    ),
  );
}

let activeManager: {
  readonly queryClient: QueryClient;
  readonly manager: EnvironmentConnectionManager;
  refCount: number;
} | null = null;

/**
 * Creates the singleton runtime manager used by the app shell.
 *
 * The local environment is always ensured first, then saved remote environments
 * are hydrated from persisted state and kept in sync with subsequent registry
 * changes.
 */
function createEnvironmentConnectionManager(
  queryClient: QueryClient,
): EnvironmentConnectionManager {
  let needsProviderInvalidation = false;
  let stopped = false;

  ensureWsRpcClientEntryForKnownEnvironment(getPrimaryWsRpcClientEntry().knownEnvironment);

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

  const orchestrationSync = startOrchestrationRegistrySync({
    applyEventBatch: (events, environmentId) => {
      if (stopped) {
        return;
      }
      applyRecoveredEventBatch(events, environmentId, queryInvalidationThrottler, (next) => {
        needsProviderInvalidation = next;
      });
    },
    syncSnapshot: (snapshot, environmentId) => {
      if (stopped) {
        return;
      }
      useStore.getState().syncServerReadModel(snapshot, environmentId);
      reconcileSnapshotDerivedState();
    },
    applyTerminalEvent: (event, environmentId) => {
      if (stopped) {
        return;
      }
      const threadRef = scopeThreadRef(environmentId, ThreadId.makeUnsafe(event.threadId));
      const thread = selectThreadByRef(useStore.getState(), threadRef);
      if (!thread || thread.archivedAt !== null) {
        return;
      }
      useTerminalStateStore.getState().applyTerminalEvent(threadRef, event);
    },
  });

  const unsubscribeSavedEnvironments = useSavedEnvironmentRegistryStore.subscribe(() => {
    void syncSavedEnvironmentConnectionsFromStore();
  });
  void syncSavedEnvironmentConnectionsFromStore();

  const primaryClientKey = getPrimaryWsRpcClientEntry().key;

  return {
    ensureEnvironmentBootstrapped: (environmentId) =>
      orchestrationSync.ensureSnapshotRecoveryForEnvironment(environmentId),
    bindPrimaryEnvironment: (environmentId) => {
      orchestrationSync.bindClientEnvironment(primaryClientKey, environmentId, {
        ensureSnapshot: false,
      });
    },
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      unsubscribeSavedEnvironments();
      orchestrationSync.dispose();
      queryInvalidationThrottler.cancel();
    },
  };
}

/**
 * Starts or reference-counts the shared environment manager.
 *
 * React Strict Mode can mount/unmount startup effects more than once, so the
 * manager is kept behind a small ref-counted singleton instead of being eagerly
 * recreated on every mount.
 */
export function startEnvironmentConnectionManager(queryClient: QueryClient): () => void {
  if (activeManager?.queryClient === queryClient) {
    activeManager.refCount += 1;
  } else {
    activeManager?.manager.stop();
    activeManager = {
      queryClient,
      manager: createEnvironmentConnectionManager(queryClient),
      refCount: 1,
    };
  }

  return () => {
    if (!activeManager || activeManager.queryClient !== queryClient) {
      return;
    }
    activeManager.refCount -= 1;
    if (activeManager.refCount > 0) {
      return;
    }
    activeManager.manager.stop();
    activeManager = null;
  };
}

export function bindPrimaryEnvironmentConnection(environmentId: EnvironmentId): void {
  activeManager?.manager.bindPrimaryEnvironment(environmentId);
}

export async function ensureEnvironmentConnectionBootstrapped(
  environmentId: EnvironmentId,
): Promise<void> {
  await activeManager?.manager.ensureEnvironmentBootstrapped(environmentId);
}
