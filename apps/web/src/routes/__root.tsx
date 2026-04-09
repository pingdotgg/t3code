import {
  type EnvironmentId,
  OrchestrationEvent,
  type ServerLifecycleWelcomePayload,
  ThreadId,
} from "@t3tools/contracts";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime";
import {
  Outlet,
  createRootRouteWithContext,
  type ErrorComponentProps,
  useNavigate,
  useLocation,
} from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { Throttler } from "@tanstack/react-pacer";

import { APP_DISPLAY_NAME } from "../branding";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import {
  SlowRpcAckToastCoordinator,
  WebSocketConnectionCoordinator,
  WebSocketConnectionSurface,
} from "../components/WebSocketConnectionSurface";
import { Button } from "../components/ui/button";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../components/ui/toast";
import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import { readLocalApi } from "../localApi";
import {
  getServerConfigUpdatedNotification,
  ServerConfigUpdatedNotification,
  startServerStateSync,
  useServerConfig,
  useServerConfigUpdatedSubscription,
  useServerWelcomeSubscription,
} from "../rpc/serverState";
import {
  markPromotedDraftThreadByRef,
  markPromotedDraftThreadsByRef,
  useComposerDraftStore,
} from "../composerDraftStore";
import {
  selectProjectsAcrossEnvironments,
  selectThreadsAcrossEnvironments,
  useStore,
} from "../store";
import { useUiStateStore } from "../uiStateStore";
import { useTerminalStateStore } from "../terminalStateStore";
import { migrateLocalSettingsToServer } from "../hooks/useSettings";
import { providerQueryKeys } from "../lib/providerReactQuery";
import { projectQueryKeys } from "../lib/projectReactQuery";
import { collectActiveTerminalThreadIds } from "../lib/terminalStateCleanup";
import { deriveOrchestrationBatchEffects } from "../orchestrationEventEffects";
import { createOrchestrationRecoveryCoordinator } from "../orchestrationRecovery";
import { deriveReplayRetryDecision } from "../orchestrationRecovery";
import { selectThreadByRef } from "../store";
import {
  bindPrimaryWsRpcClientEnvironment,
  bindWsRpcClientEntryEnvironment,
  getPrimaryWsRpcClientEntry,
  listWsRpcClientEntries,
  subscribeWsRpcClientRegistry,
  type WsRpcClientEntry,
} from "~/wsRpcClient";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteView() {
  if (!readLocalApi()) {
    return (
      <div className="flex h-screen flex-col bg-background text-foreground">
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">
            Connecting to {APP_DISPLAY_NAME} server...
          </p>
        </div>
      </div>
    );
  }

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <ServerStateBootstrap />
        <EventRouter />
        <WebSocketConnectionCoordinator />
        <SlowRpcAckToastCoordinator />
        <WebSocketConnectionSurface>
          <AppSidebarLayout>
            <Outlet />
          </AppSidebarLayout>
        </WebSocketConnectionSurface>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function RootRouteErrorView({ error, reset }: ErrorComponentProps) {
  const message = errorMessage(error);
  const details = errorDetails(error);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-red-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
          Something went wrong.
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{message}</p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => reset()}>
            Try again
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            Reload app
          </Button>
        </div>

        <details className="group mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted-foreground">
            <span className="group-open:hidden">Show error details</span>
            <span className="hidden group-open:inline">Hide error details</span>
          </summary>
          <pre className="max-h-56 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs text-foreground/85">
            {details}
          </pre>
        </details>
      </section>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
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

const REPLAY_RECOVERY_RETRY_DELAY_MS = 100;
const MAX_NO_PROGRESS_REPLAY_RETRIES = 3;

function useRegisteredWsRpcClientEntries(): ReadonlyArray<WsRpcClientEntry> {
  const [, setRevision] = useState(0);

  useEffect(() => subscribeWsRpcClientRegistry(() => setRevision((value) => value + 1)), []);

  const entries = listWsRpcClientEntries();
  return entries.length > 0 ? entries : [getPrimaryWsRpcClientEntry()];
}

function ServerStateBootstrap() {
  useEffect(() => startServerStateSync(getPrimaryWsRpcClientEntry().client.server), []);

  return null;
}

function EventRouter() {
  const applyOrchestrationEvents = useStore((store) => store.applyOrchestrationEvents);
  const setActiveEnvironmentId = useStore((store) => store.setActiveEnvironmentId);
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const setProjectExpanded = useUiStateStore((store) => store.setProjectExpanded);
  const syncProjects = useUiStateStore((store) => store.syncProjects);
  const syncThreads = useUiStateStore((store) => store.syncThreads);
  const clearThreadUi = useUiStateStore((store) => store.clearThreadUi);
  const removeTerminalState = useTerminalStateStore((store) => store.removeTerminalState);
  const removeOrphanedTerminalStates = useTerminalStateStore(
    (store) => store.removeOrphanedTerminalStates,
  );
  const applyTerminalEvent = useTerminalStateStore((store) => store.applyTerminalEvent);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const readPathname = useEffectEvent(() => pathname);
  const handledBootstrapThreadIdRef = useRef<string | null>(null);
  const seenServerConfigUpdateIdRef = useRef(getServerConfigUpdatedNotification()?.id ?? 0);
  const disposedRef = useRef(false);
  const bootstrapFromSnapshotRef = useRef<(environmentId: EnvironmentId) => Promise<void>>(
    async () => undefined,
  );
  const schedulePendingDomainEventFlushRef = useRef<() => void>(() => undefined);
  const serverConfig = useServerConfig();
  const clientEntries = useRegisteredWsRpcClientEntries();

  const handleWelcome = useEffectEvent((payload: ServerLifecycleWelcomePayload | null) => {
    if (!payload) return;

    bindPrimaryWsRpcClientEnvironment(payload.environment.environmentId);
    setActiveEnvironmentId(payload.environment.environmentId);
    schedulePendingDomainEventFlushRef.current();
    migrateLocalSettingsToServer();
    void (async () => {
      await bootstrapFromSnapshotRef.current(payload.environment.environmentId);
      if (disposedRef.current) {
        return;
      }

      if (!payload.bootstrapProjectId || !payload.bootstrapThreadId) {
        return;
      }
      setProjectExpanded(
        scopedProjectKey(
          scopeProjectRef(payload.environment.environmentId, payload.bootstrapProjectId),
        ),
        true,
      );

      if (readPathname() !== "/") {
        return;
      }
      if (handledBootstrapThreadIdRef.current === payload.bootstrapThreadId) {
        return;
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: payload.environment.environmentId,
          threadId: payload.bootstrapThreadId,
        },
        replace: true,
      });
      handledBootstrapThreadIdRef.current = payload.bootstrapThreadId;
    })().catch(() => undefined);
  });

  const handleServerConfigUpdated = useEffectEvent(
    (notification: ServerConfigUpdatedNotification | null) => {
      if (!notification) return;

      const { id, payload, source } = notification;
      if (id <= seenServerConfigUpdateIdRef.current) {
        return;
      }
      seenServerConfigUpdateIdRef.current = id;
      if (source !== "keybindingsUpdated") {
        return;
      }

      const issue = payload.issues.find((entry) => entry.kind.startsWith("keybindings."));
      if (!issue) {
        toastManager.add({
          type: "success",
          title: "Keybindings updated",
          description: "Keybindings configuration reloaded successfully.",
        });
        return;
      }

      toastManager.add({
        type: "warning",
        title: "Invalid keybindings configuration",
        description: issue.message,
        actionProps: {
          children: "Open keybindings.json",
          onClick: () => {
            const api = readLocalApi();
            if (!api) {
              return;
            }

            void Promise.resolve(serverConfig ?? api.server.getConfig())
              .then((config) => {
                const editor = resolveAndPersistPreferredEditor(config.availableEditors);
                if (!editor) {
                  throw new Error("No available editors found.");
                }
                return api.shell.openInEditor(config.keybindingsConfigPath, editor);
              })
              .catch((error) => {
                toastManager.add({
                  type: "error",
                  title: "Unable to open keybindings file",
                  description:
                    error instanceof Error ? error.message : "Unknown error opening file.",
                });
              });
          },
        },
      });
    },
  );

  useEffect(() => {
    if (!serverConfig) {
      return;
    }

    bindPrimaryWsRpcClientEnvironment(serverConfig.environment.environmentId);
    setActiveEnvironmentId(serverConfig.environment.environmentId);
    schedulePendingDomainEventFlushRef.current();
  }, [serverConfig, setActiveEnvironmentId]);

  useEffect(() => {
    let disposed = false;
    disposedRef.current = false;
    let needsProviderInvalidation = false;
    const primaryClientKey = getPrimaryWsRpcClientEntry().key;

    const reconcileSnapshotDerivedState = () => {
      const storeState = useStore.getState();
      const threads = selectThreadsAcrossEnvironments(storeState);
      const projects = selectProjectsAcrossEnvironments(storeState);
      syncProjects(
        projects.map((project) => ({
          key: scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
          cwd: project.cwd,
        })),
      );
      syncThreads(
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
      removeOrphanedTerminalStates(activeThreadKeys);
    };

    const queryInvalidationThrottler = new Throttler(
      () => {
        if (!needsProviderInvalidation) {
          return;
        }
        needsProviderInvalidation = false;
        void queryClient.invalidateQueries({ queryKey: providerQueryKeys.all });
        // Invalidate workspace entry queries so the @-mention file picker
        // reflects files created, deleted, or restored during this turn.
        void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
      },
      {
        wait: 100,
        leading: false,
        trailing: true,
      },
    );

    const applyEventBatch = (
      events: ReadonlyArray<OrchestrationEvent>,
      environmentId: EnvironmentId,
      recovery: ReturnType<typeof createOrchestrationRecoveryCoordinator>,
    ) => {
      const nextEvents = recovery.markEventBatchApplied(events);
      if (nextEvents.length === 0) {
        return;
      }

      const batchEffects = deriveOrchestrationBatchEffects(nextEvents);
      const uiEvents = coalesceOrchestrationUiEvents(nextEvents);
      const needsProjectUiSync = nextEvents.some(
        (event) =>
          event.type === "project.created" ||
          event.type === "project.meta-updated" ||
          event.type === "project.deleted",
      );

      if (batchEffects.needsProviderInvalidation) {
        needsProviderInvalidation = true;
        void queryInvalidationThrottler.maybeExecute();
      }

      applyOrchestrationEvents(uiEvents, environmentId);
      if (needsProjectUiSync) {
        const projects = selectProjectsAcrossEnvironments(useStore.getState());
        syncProjects(
          projects.map((project) => ({
            key: scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
            cwd: project.cwd,
          })),
        );
      }
      const needsThreadUiSync = nextEvents.some(
        (event) => event.type === "thread.created" || event.type === "thread.deleted",
      );
      if (needsThreadUiSync) {
        const threads = selectThreadsAcrossEnvironments(useStore.getState());
        syncThreads(
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
        clearThreadUi(scopedThreadKey(scopeThreadRef(environmentId, threadId)));
      }
      for (const threadId of batchEffects.removeTerminalStateThreadIds) {
        removeTerminalState(scopeThreadRef(environmentId, threadId));
      }
    };
    const clientContexts = clientEntries.map((entry) => {
      const recovery = createOrchestrationRecoveryCoordinator();
      let replayRetryTracker: import("../orchestrationRecovery").ReplayRetryTracker | null = null;
      const pendingDomainEvents: OrchestrationEvent[] = [];
      let flushPendingDomainEventsScheduled = false;
      let boundEnvironmentId = entry.environmentId;

      const bindEnvironmentId = (environmentId: EnvironmentId) => {
        if (boundEnvironmentId === environmentId) {
          return;
        }
        boundEnvironmentId = environmentId;
        bindWsRpcClientEntryEnvironment(entry.key, environmentId);
        schedulePendingDomainEventFlush();
      };

      const flushPendingDomainEvents = () => {
        flushPendingDomainEventsScheduled = false;
        if (disposed || pendingDomainEvents.length === 0 || boundEnvironmentId === null) {
          return;
        }

        const events = pendingDomainEvents.splice(0, pendingDomainEvents.length);
        applyEventBatch(events, boundEnvironmentId, recovery);
      };

      const schedulePendingDomainEventFlush = () => {
        if (flushPendingDomainEventsScheduled) {
          return;
        }

        flushPendingDomainEventsScheduled = true;
        queueMicrotask(flushPendingDomainEvents);
      };

      const runSnapshotRecovery = async (
        reason: "bootstrap" | "replay-failed",
        environmentId: EnvironmentId,
      ): Promise<void> => {
        const started = recovery.beginSnapshotRecovery(reason);
        if (import.meta.env.MODE !== "test") {
          const state = recovery.getState();
          console.info("[orchestration-recovery]", "Snapshot recovery requested.", {
            reason,
            clientKey: entry.key,
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
            bindEnvironmentId(environmentId);
            syncServerReadModel(snapshot, environmentId);
            reconcileSnapshotDerivedState();
            if (recovery.completeSnapshotRecovery(snapshot.snapshotSequence)) {
              void runReplayRecovery("sequence-gap");
            }
          }
        } catch {
          recovery.failSnapshotRecovery();
        }
      };

      const fallbackToSnapshotRecovery = async (): Promise<void> => {
        if (boundEnvironmentId === null) {
          return;
        }
        await runSnapshotRecovery("replay-failed", boundEnvironmentId);
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
            applyEventBatch(events, boundEnvironmentId, recovery);
          }
        } catch {
          replayRetryTracker = null;
          recovery.failReplayRecovery();
          void fallbackToSnapshotRecovery();
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
                clientKey: entry.key,
                environmentId: boundEnvironmentId,
                state: recovery.getState(),
              },
            );
          }
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
      if (boundEnvironmentId === null) {
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

        const threadRef = scopeThreadRef(boundEnvironmentId, ThreadId.makeUnsafe(event.threadId));
        const thread = selectThreadByRef(useStore.getState(), threadRef);
        if (!thread || thread.archivedAt !== null) {
          return;
        }
        applyTerminalEvent(threadRef, event);
      });

      return {
        key: entry.key,
        bindEnvironmentId,
        flushPendingDomainEvents,
        schedulePendingDomainEventFlush,
        runSnapshotRecovery,
        cleanup: () => {
          flushPendingDomainEventsScheduled = false;
          pendingDomainEvents.length = 0;
          unsubDomainEvent();
          unsubTerminalEvent();
          unsubLifecycle();
          unsubConfig();
        },
      };
    });

    schedulePendingDomainEventFlushRef.current = () => {
      for (const context of clientContexts) {
        context.schedulePendingDomainEventFlush();
      }
    };

    const primaryClientContext =
      clientContexts.find((context) => context.key === primaryClientKey) ??
      clientContexts[0] ??
      null;
    bootstrapFromSnapshotRef.current = async (environmentId: EnvironmentId) => {
      if (!primaryClientContext) {
        return;
      }
      primaryClientContext.bindEnvironmentId(environmentId);
      await primaryClientContext.runSnapshotRecovery("bootstrap", environmentId);
    };

    return () => {
      disposed = true;
      disposedRef.current = true;
      needsProviderInvalidation = false;
      schedulePendingDomainEventFlushRef.current = () => undefined;
      queryInvalidationThrottler.cancel();
      for (const context of clientContexts) {
        context.cleanup();
      }
    };
  }, [
    applyOrchestrationEvents,
    clientEntries,
    navigate,
    queryClient,
    removeTerminalState,
    removeOrphanedTerminalStates,
    applyTerminalEvent,
    clearThreadUi,
    setProjectExpanded,
    setActiveEnvironmentId,
    syncProjects,
    syncServerReadModel,
    syncThreads,
  ]);

  useServerWelcomeSubscription(handleWelcome);
  useServerConfigUpdatedSubscription(handleServerConfigUpdated);

  return null;
}
