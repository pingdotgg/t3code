import {
  type DesktopNotificationRequest,
  type DesktopThreadCompletionNotificationStatus,
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
import { readLocalApi } from "../localApi";
import { useSettings } from "../hooks/useSettings";
import { useAppFont } from "../hooks/useAppFont";
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
import { syncBrowserChromeTheme } from "../hooks/useTheme";
import {
  ensureEnvironmentConnectionBootstrapped,
  getPrimaryEnvironmentConnection,
  startEnvironmentConnectionService,
} from "../environments/runtime";
import { configureClientTracing } from "../observability/clientTracing";
import {
  ensurePrimaryEnvironmentReady,
  resolveInitialServerAuthGateState,
  updatePrimaryEnvironmentDescriptor,
} from "../environments/primary";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  beforeLoad: async () => {
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
  useAppFont();

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

  if (authGateState.status !== "authenticated") {
    return <Outlet />;
  }
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <AuthenticatedTracingBootstrap />
        <ServerStateBootstrap />
        <EnvironmentConnectionManagerBootstrap />
        <ThreadCompletionNotificationCoordinator />
        <EventRouter />
        <WebSocketConnectionCoordinator />
        <SlowRpcAckToastCoordinator />
        <WebSocketConnectionSurface>
          <CommandPalette>
            <AppSidebarLayout>
              <Outlet />
            </AppSidebarLayout>
          </CommandPalette>
        </WebSocketConnectionSurface>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function ThreadCompletionNotificationCoordinator() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const environmentStateById = useStore((store) => store.environmentStateById);
  const notificationMode = useSettings((settings) => settings.threadCompletionNotifications);
  const notifiedTurnKeysRef = useRef(new Set<string>());
  const initializedRef = useRef(false);

  useEffect(() => {
    const api = readLocalApi();
    if (!api) {
      return;
    }

    return api.notifications.onClick((click) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: click.environmentId,
          threadId: click.threadId,
        },
      });
    });
  }, [navigate]);

  useEffect(() => {
    if (notificationMode === "off") {
      return;
    }

    const api = readLocalApi();
    if (!api || !window.desktopBridge) {
      return;
    }

    const activeThreadKey = parseActiveThreadRouteKey(pathname);
    for (const environmentState of Object.values(environmentStateById)) {
      for (const summary of Object.values(environmentState.sidebarThreadSummaryById)) {
        const latestTurn = summary.latestTurn;
        if (!latestTurn || !latestTurn.completedAt) {
          continue;
        }

        const status = notificationStatusFromTurnState(latestTurn.state);
        if (!status) {
          continue;
        }

        const turnKey = `${summary.environmentId}:${summary.id}:${latestTurn.turnId}`;
        if (notifiedTurnKeysRef.current.has(turnKey)) {
          continue;
        }

        notifiedTurnKeysRef.current.add(turnKey);
        if (!initializedRef.current) {
          continue;
        }

        if (
          notificationMode === "background-only" &&
          isThreadVisibleAndFocused(activeThreadKey, summary.environmentId, summary.id)
        ) {
          continue;
        }

        const request: DesktopNotificationRequest = {
          kind: "thread-turn-completed",
          environmentId: summary.environmentId,
          threadId: summary.id,
          turnId: latestTurn.turnId,
          title: notificationTitleFromStatus(status),
          body: summary.title,
          status,
          createdAt: latestTurn.completedAt,
        };
        void api.notifications.show(request).catch((error) => {
          console.error("[THREAD_COMPLETION_NOTIFICATION] show failed", error);
        });
      }
    }

    initializedRef.current = true;
  }, [environmentStateById, notificationMode, pathname]);

  return null;
}

function notificationStatusFromTurnState(
  state: string,
): DesktopThreadCompletionNotificationStatus | null {
  switch (state) {
    case "completed":
      return "completed";
    case "error":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return null;
  }
}

function notificationTitleFromStatus(status: DesktopThreadCompletionNotificationStatus): string {
  switch (status) {
    case "completed":
      return "Chat completed";
    case "failed":
      return "Chat failed";
    case "interrupted":
      return "Chat interrupted";
    case "cancelled":
      return "Chat cancelled";
  }
}

function parseActiveThreadRouteKey(pathname: string): string | null {
  const [, environmentId, threadId] = pathname.split("/");
  if (!environmentId || !threadId) {
    return null;
  }
  return `${decodeURIComponent(environmentId)}:${decodeURIComponent(threadId)}`;
}

function isThreadVisibleAndFocused(
  activeThreadKey: string | null,
  environmentId: string,
  threadId: string,
): boolean {
  return (
    document.visibilityState === "visible" &&
    document.hasFocus() &&
    activeThreadKey === `${environmentId}:${threadId}`
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

function ServerStateBootstrap() {
  useEffect(() => startServerStateSync(getPrimaryEnvironmentConnection().client.server), []);

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
  const disposedRef = useRef(false);
  const serverConfig = useServerConfig();

  const handleWelcome = useEffectEvent((payload: ServerLifecycleWelcomePayload | null) => {
    if (!payload) return;

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
