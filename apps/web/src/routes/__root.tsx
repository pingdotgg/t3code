import {
  OrchestrationEvent,
  ThreadId,
  type OrchestrationSessionStatus,
  type ServerLifecycleWelcomePayload,
} from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime";
import {
  Outlet,
  createRootRouteWithContext,
  type ErrorComponentProps,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";

import { APP_DISPLAY_NAME } from "../branding";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { CommandPalette } from "../components/CommandPalette";
import { SshPasswordPromptDialog } from "../components/desktop/SshPasswordPromptDialog";
import { ProviderUpdateLaunchNotification } from "../components/ProviderUpdateLaunchNotification";
import {
  SlowRpcAckToastCoordinator,
  WebSocketConnectionCoordinator,
  WebSocketConnectionSurface,
} from "../components/WebSocketConnectionSurface";
import { Button } from "../components/ui/button";
import {
  AnchoredToastProvider,
  stackedThreadToast,
  ToastProvider,
  toastManager,
} from "../components/ui/toast";
import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import { readNativeApi } from "../nativeApi";
import { NotificationLevel } from "@t3tools/contracts/settings";
import { useSettings } from "../hooks/useSettings";
import { readLocalApi } from "../localApi";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKeyFromPath,
} from "../logicalProject";
import {
  getServerConfigUpdatedNotification,
  ServerConfigUpdatedNotification,
  startServerStateSync,
  useServerConfig,
  useServerConfigUpdatedSubscription,
  useServerWelcomeSubscription,
} from "../rpc/serverState";
import { useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import { useTerminalStateStore } from "../terminalStateStore";
import { terminalRunningSubprocessFromEvent } from "../terminalActivity";
import { migrateLocalSettingsToServer } from "../hooks/useSettings";
import { providerQueryKeys } from "../lib/providerReactQuery";
import { projectQueryKeys } from "../lib/projectReactQuery";
import { collectActiveTerminalThreadIds } from "../lib/terminalStateCleanup";
import { deriveOrchestrationBatchEffects } from "../orchestrationEventEffects";
import { createOrchestrationRecoveryCoordinator } from "../orchestrationRecovery";
import {
  isAppBackgrounded,
  resolveAttentionNotification,
  resolveTurnCompletionNotification,
  showNativeNotification,
  type NotifiableThread,
} from "../lib/nativeNotifications";
import { syncBrowserChromeTheme } from "../hooks/useTheme";
import {
  ensureEnvironmentConnectionBootstrapped,
  getPrimaryEnvironmentConnection,
  listSavedEnvironmentRecords,
  waitForSavedEnvironmentRegistryHydration,
  startEnvironmentConnectionService,
  useSavedEnvironmentRegistryStore,
} from "../environments/runtime";
import { configureClientTracing } from "../observability/clientTracing";
import {
  ensurePrimaryEnvironmentReady,
  getPrimaryKnownEnvironment,
  resolveInitialServerAuthGateState,
  updatePrimaryEnvironmentDescriptor,
} from "../environments/primary";
import { hasHostedPairingRequest, isHostedStaticApp } from "../hostedPairing";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  beforeLoad: async ({ location }) => {
    if (location.pathname === "/pair" && hasHostedPairingRequest(new URL(window.location.href))) {
      return {
        authGateState: {
          status: "hosted-pairing",
        } as const,
      };
    }

    if (isHostedStaticApp(new URL(window.location.href))) {
      await waitForSavedEnvironmentRegistryHydration();
      return {
        authGateState: {
          status: "hosted-static",
        } as const,
      };
    }

    const [, authGateState] = await Promise.all([
      ensurePrimaryEnvironmentReady(),
      resolveInitialServerAuthGateState(),
    ]);
    return {
      authGateState,
    };
  },
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteView() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { authGateState } = Route.useRouteContext();
  const primaryEnvironmentAuthenticated = authGateState.status === "authenticated";

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      syncBrowserChromeTheme();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [pathname]);

  if (pathname === "/pair") {
    return <Outlet />;
  }

  if (authGateState.status !== "authenticated" && authGateState.status !== "hosted-static") {
    return <Outlet />;
  }

  const appShell = (
    <CommandPalette>
      <AppSidebarLayout>
        <Outlet />
      </AppSidebarLayout>
    </CommandPalette>
  );

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        {primaryEnvironmentAuthenticated ? <AuthenticatedTracingBootstrap /> : null}
        {primaryEnvironmentAuthenticated ? <ServerStateBootstrap /> : null}
        <EnvironmentConnectionManagerBootstrap />
        <SshPasswordPromptDialog />
        <HostedStaticEnvironmentBootstrap />
        {primaryEnvironmentAuthenticated ? <EventRouter /> : null}
        {primaryEnvironmentAuthenticated ? <ProviderUpdateLaunchNotification /> : null}
        {primaryEnvironmentAuthenticated ? <WebSocketConnectionCoordinator /> : null}
        {primaryEnvironmentAuthenticated ? <SlowRpcAckToastCoordinator /> : null}
        {primaryEnvironmentAuthenticated ? (
          <WebSocketConnectionSurface>{appShell}</WebSocketConnectionSurface>
        ) : (
          appShell
        )}
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function HostedStaticEnvironmentBootstrap() {
  const savedEnvironmentCount = useSavedEnvironmentRegistryStore(
    (state) => Object.keys(state.byId).length,
  );

  useEffect(() => {
    if (getPrimaryKnownEnvironment()) {
      return;
    }

    const currentActiveEnvironmentId = useStore.getState().activeEnvironmentId;
    if (currentActiveEnvironmentId) {
      return;
    }

    const firstSavedEnvironment = listSavedEnvironmentRecords()[0];
    if (!firstSavedEnvironment) {
      return;
    }

    useStore.getState().setActiveEnvironmentId(firstSavedEnvironment.environmentId);
  }, [savedEnvironmentCount]);

  return null;
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

function ServerStateBootstrap() {
  useEffect(() => {
    if (!getPrimaryKnownEnvironment()) {
      return;
    }

    return startServerStateSync(getPrimaryEnvironmentConnection().client.server);
  }, []);

  return null;
}

function AuthenticatedTracingBootstrap() {
  useEffect(() => {
    void configureClientTracing();
  }, []);

  return null;
}

function EnvironmentConnectionManagerBootstrap() {
  const queryClient = useQueryClient();

  useEffect(() => {
    return startEnvironmentConnectionService(queryClient);
  }, [queryClient]);

  return null;
}

function EventRouter() {
  const applyOrchestrationEvents = useStore((store) => store.applyOrchestrationEvents);
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const setProjectExpanded = useUiStateStore((store) => store.setProjectExpanded);
  const syncProjects = useUiStateStore((store) => store.syncProjects);
  const syncThreads = useUiStateStore((store) => store.syncThreads);
  const clearThreadUi = useUiStateStore((store) => store.clearThreadUi);
  const removeTerminalState = useTerminalStateStore((store) => store.removeTerminalState);
  const removeOrphanedTerminalStates = useTerminalStateStore(
    (store) => store.removeOrphanedTerminalStates,
  );
  const notificationLevel = useSettings((state) => state.notificationLevel);
  const setActiveEnvironmentId = useStore((store) => store.setActiveEnvironmentId);
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const projectGroupingSettings = useSettings((settings) => ({
    sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  }));
  const readPathname = useEffectEvent(() => pathname);
  const handledBootstrapThreadIdRef = useRef<string | null>(null);
  const seenServerConfigUpdateIdRef = useRef(getServerConfigUpdatedNotification()?.id ?? 0);
  const lastKeybindingsSuccessToastAtRef = useRef(0);
  const disposedRef = useRef(false);
  const serverConfig = useServerConfig();
  const lastSessionByThreadRef = useRef(
    new Map<string, { status: OrchestrationSessionStatus; activeTurnId: string | null }>(),
  );
  const lastNotifiedTurnByThreadRef = useRef(new Map<string, string>());
  const lastNotifiedActivityByThreadRef = useRef(new Map<string, string>());

  const maybeNotifyForThreads = useEffectEvent((threads: ReadonlyArray<NotifiableThread>) => {
    // Only notify when the app is backgrounded and notifications are enabled.
    const shouldNotify = isAppBackgrounded() && notificationLevel !== NotificationLevel.Off;
    const seenThreadIds = new Set<string>();
    for (const thread of threads) {
      seenThreadIds.add(thread.id);
      const session = thread.session;
      const previous = lastSessionByThreadRef.current.get(thread.id);

      const completionNotification = resolveTurnCompletionNotification({
        shouldNotify,
        level: notificationLevel,
        thread,
        previous,
        lastNotifiedTurnId: lastNotifiedTurnByThreadRef.current.get(thread.id),
      });

      if (completionNotification) {
        const { title, body, tag, turnId } = completionNotification;
        if (showNativeNotification({ title, body, tag })) {
          lastNotifiedTurnByThreadRef.current.set(thread.id, turnId);
        }
      }

      const attentionNotification = resolveAttentionNotification({
        shouldNotify,
        level: notificationLevel,
        thread,
        lastNotifiedActivityId: lastNotifiedActivityByThreadRef.current.get(thread.id),
      });

      if (attentionNotification) {
        const { title, body, tag, activityId } = attentionNotification;
        if (showNativeNotification({ title, body, tag })) {
          lastNotifiedActivityByThreadRef.current.set(thread.id, activityId);
        }
      }

      if (session) {
        // Persist latest session state so we can detect transitions next time.
        const status =
          "orchestrationStatus" in session ? session.orchestrationStatus : session.status;
        lastSessionByThreadRef.current.set(thread.id, {
          status,
          activeTurnId: session.activeTurnId ?? null,
        });
      } else {
        lastSessionByThreadRef.current.delete(thread.id);
      }
    }

    // Drop state for threads that no longer exist in the snapshot.
    for (const threadId of lastSessionByThreadRef.current.keys()) {
      if (!seenThreadIds.has(threadId)) {
        lastSessionByThreadRef.current.delete(threadId);
        lastNotifiedTurnByThreadRef.current.delete(threadId);
        lastNotifiedActivityByThreadRef.current.delete(threadId);
      }
    }
  });

  const handleWelcome = useEffectEvent((payload: ServerLifecycleWelcomePayload) => {
    migrateLocalSettingsToServer();
    updatePrimaryEnvironmentDescriptor(payload.environment);
    setActiveEnvironmentId(payload.environment.environmentId);
    void (async () => {
      await ensureEnvironmentConnectionBootstrapped(payload.environment.environmentId);
      if (disposedRef.current) {
        return;
      }
      if (!payload.bootstrapProjectId || !payload.bootstrapThreadId) {
        return;
      }
      const bootstrapEnvironmentState =
        useStore.getState().environmentStateById[payload.environment.environmentId];
      const bootstrapProject =
        bootstrapEnvironmentState?.projectById[payload.bootstrapProjectId] ?? null;
      const bootstrapProjectKey =
        (bootstrapProject
          ? deriveLogicalProjectKeyFromSettings(bootstrapProject, projectGroupingSettings)
          : null) ??
        (serverConfig?.cwd
          ? derivePhysicalProjectKeyFromPath(payload.environment.environmentId, serverConfig.cwd)
          : null) ??
        scopedProjectKey(
          scopeProjectRef(payload.environment.environmentId, payload.bootstrapProjectId),
        );
      useUiStateStore.getState().setProjectExpanded(bootstrapProjectKey, true);

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
        const now = Date.now();
        if (now - lastKeybindingsSuccessToastAtRef.current < 2_000) {
          return;
        }
        lastKeybindingsSuccessToastAtRef.current = now;
        toastManager.add({
          type: "success",
          title: "Keybindings updated",
          description: "Keybindings configuration reloaded successfully.",
        });
        return;
      }

      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Invalid keybindings configuration",
          description: issue.message,
          actionVariant: "outline",
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
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: "Unable to open keybindings file",
                      description:
                        error instanceof Error ? error.message : "Unknown error opening file.",
                    }),
                  );
                });
            },
          },
        }),
      );
    },
  );

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    let disposed = false;
    disposedRef.current = false;
    const recovery = createOrchestrationRecoveryCoordinator();
    let needsProviderInvalidation = false;
    const pendingDomainEvents: OrchestrationEvent[] = [];
    let flushPendingDomainEventsScheduled = false;

    const reconcileSnapshotDerivedState = () => {
      const threads = useStore.getState().threads;
      const projects = useStore.getState().projects;
      syncProjects(projects.map((project) => ({ id: project.id, cwd: project.cwd })));
      syncThreads(
        threads.map((thread) => ({
          id: thread.id,
          seedVisitedAt: thread.updatedAt ?? thread.createdAt,
        })),
      );
      clearPromotedDraftThreads(threads.map((thread) => thread.id));
      const draftThreadIds = Object.keys(
        useComposerDraftStore.getState().draftThreadsByThreadId,
      ) as ThreadId[];
      const activeThreadIds = collectActiveTerminalThreadIds({
        snapshotThreads: threads.map((thread) => ({ id: thread.id, deletedAt: null })),
        draftThreadIds,
      });
      removeOrphanedTerminalStates(activeThreadIds);
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

    const applyEventBatch = (events: ReadonlyArray<OrchestrationEvent>) => {
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

      applyOrchestrationEvents(uiEvents);
      if (needsProjectUiSync) {
        const projects = useStore.getState().projects;
        syncProjects(projects.map((project) => ({ id: project.id, cwd: project.cwd })));
      }
      const needsThreadUiSync = nextEvents.some(
        (event) => event.type === "thread.created" || event.type === "thread.deleted",
      );
      if (needsThreadUiSync) {
        const threads = useStore.getState().threads;
        syncThreads(
          threads.map((thread) => ({
            id: thread.id,
            seedVisitedAt: thread.updatedAt ?? thread.createdAt,
          })),
        );
      }
      const draftStore = useComposerDraftStore.getState();
      for (const threadId of batchEffects.clearPromotedDraftThreadIds) {
        clearPromotedDraftThread(threadId);
      }
      for (const threadId of batchEffects.clearDeletedThreadIds) {
        draftStore.clearDraftThread(threadId);
        clearThreadUi(threadId);
      }
      for (const threadId of batchEffects.removeTerminalStateThreadIds) {
        removeTerminalState(threadId);
      }
      maybeNotifyForThreads(useStore.getState().threads);
    };
    const flushPendingDomainEvents = () => {
      flushPendingDomainEventsScheduled = false;
      if (disposed || pendingDomainEvents.length === 0) {
        return;
      }

      const events = pendingDomainEvents.splice(0, pendingDomainEvents.length);
      applyEventBatch(events);
    };
    const schedulePendingDomainEventFlush = () => {
      if (flushPendingDomainEventsScheduled) {
        return;
      }

      flushPendingDomainEventsScheduled = true;
      queueMicrotask(flushPendingDomainEvents);
    };

    const recoverFromSequenceGap = async (): Promise<void> => {
      if (!recovery.beginReplayRecovery("sequence-gap")) {
        return;
      }

      try {
        const events = await api.orchestration.replayEvents(recovery.getState().latestSequence);
        if (!disposed) {
          applyEventBatch(events);
        }
      } catch {
        recovery.failReplayRecovery();
        void fallbackToSnapshotRecovery();
        return;
      }

      if (!disposed && recovery.completeReplayRecovery()) {
        void recoverFromSequenceGap();
      }
    };

    const runSnapshotRecovery = async (reason: "bootstrap" | "replay-failed"): Promise<void> => {
      if (!recovery.beginSnapshotRecovery(reason)) {
        return;
      }

      try {
        const snapshot = await api.orchestration.getSnapshot();
        if (!disposed) {
          syncServerReadModel(snapshot);
          reconcileSnapshotDerivedState();
          maybeNotifyForThreads(snapshot.threads);
          if (recovery.completeSnapshotRecovery(snapshot.snapshotSequence)) {
            void recoverFromSequenceGap();
          }
        }
      } catch {
        // Keep prior state and wait for welcome or a later replay attempt.
        recovery.failSnapshotRecovery();
      }
    };
    if (!serverConfig) {
      return;
    }

    updatePrimaryEnvironmentDescriptor(serverConfig.environment);
    setActiveEnvironmentId(serverConfig.environment.environmentId);
  }, [serverConfig, setActiveEnvironmentId]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);

  useServerWelcomeSubscription(handleWelcome);
  useServerConfigUpdatedSubscription(handleServerConfigUpdated);

  return null;
}
