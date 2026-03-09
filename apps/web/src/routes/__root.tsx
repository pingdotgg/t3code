import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_RUNTIME_MODE,
  type DesktopLauncherState,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import {
  Outlet,
  createRootRouteWithContext,
  type ErrorComponentProps,
  useNavigate,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";

import { APP_DISPLAY_NAME } from "../branding";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { AnchoredToastProvider, ToastProvider, toastManager } from "../components/ui/toast";
import { serverConfigQueryOptions, serverQueryKeys } from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import { type DraftThreadEnvMode, useComposerDraftStore } from "../composerDraftStore";
import { newCommandId, newProjectId, newThreadId } from "../lib/utils";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { preferredTerminalEditor } from "../terminal-links";
import { terminalRunningSubprocessFromEvent } from "../terminalActivity";
import { onServerConfigUpdated, onServerWelcome } from "../wsNativeApi";
import { providerQueryKeys } from "../lib/providerReactQuery";
import { collectActiveTerminalThreadIds } from "../lib/terminalStateCleanup";
import { workspacePathsMatch } from "../lib/workspacePaths";

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
  if (!readNativeApi()) {
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
        <EventRouter />
        <DesktopProjectBootstrap />
        <Outlet />
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

function EventRouter() {
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const setProjectExpanded = useStore((store) => store.setProjectExpanded);
  const removeOrphanedTerminalStates = useTerminalStateStore(
    (store) => store.removeOrphanedTerminalStates,
  );
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const pathnameRef = useRef(pathname);
  const lastConfigIssuesSignatureRef = useRef<string | null>(null);
  const handledBootstrapThreadIdRef = useRef<string | null>(null);

  pathnameRef.current = pathname;

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    let disposed = false;
    let latestSequence = 0;
    let syncing = false;
    let pending = false;

    const flushSnapshotSync = async (): Promise<void> => {
      const snapshot = await api.orchestration.getSnapshot();
      if (disposed) return;
      latestSequence = Math.max(latestSequence, snapshot.snapshotSequence);
      syncServerReadModel(snapshot);
      const draftThreadIds = Object.keys(
        useComposerDraftStore.getState().draftThreadsByThreadId,
      ) as ThreadId[];
      const activeThreadIds = collectActiveTerminalThreadIds({
        snapshotThreads: snapshot.threads,
        draftThreadIds,
      });
      removeOrphanedTerminalStates(activeThreadIds);
      if (pending) {
        pending = false;
        await flushSnapshotSync();
      }
    };

    const syncSnapshot = async () => {
      if (syncing) {
        pending = true;
        return;
      }
      syncing = true;
      pending = false;
      try {
        await flushSnapshotSync();
      } catch {
        // Keep prior state and wait for next domain event to trigger a resync.
      }
      syncing = false;
    };

    void syncSnapshot().catch(() => undefined);

    const unsubDomainEvent = api.orchestration.onDomainEvent((event) => {
      if (event.sequence <= latestSequence) {
        return;
      }
      latestSequence = event.sequence;
      if (event.type === "thread.turn-diff-completed" || event.type === "thread.reverted") {
        void queryClient.invalidateQueries({ queryKey: providerQueryKeys.all });
      }
      void syncSnapshot();
    });
    const unsubTerminalEvent = api.terminal.onEvent((event) => {
      const hasRunningSubprocess = terminalRunningSubprocessFromEvent(event);
      if (hasRunningSubprocess === null) {
        return;
      }
      useTerminalStateStore
        .getState()
        .setTerminalActivity(
          ThreadId.makeUnsafe(event.threadId),
          event.terminalId,
          hasRunningSubprocess,
        );
    });
    const unsubWelcome = onServerWelcome((payload) => {
      void (async () => {
        await syncSnapshot();
        if (disposed) {
          return;
        }

        if (!payload.bootstrapProjectId || !payload.bootstrapThreadId) {
          return;
        }
        setProjectExpanded(payload.bootstrapProjectId, true);

        if (pathnameRef.current !== "/") {
          return;
        }
        if (handledBootstrapThreadIdRef.current === payload.bootstrapThreadId) {
          return;
        }
        await navigate({
          to: "/$threadId",
          params: { threadId: payload.bootstrapThreadId },
          replace: true,
        });
        handledBootstrapThreadIdRef.current = payload.bootstrapThreadId;
      })().catch(() => undefined);
    });
    const unsubServerConfigUpdated = onServerConfigUpdated((payload) => {
      const signature = JSON.stringify(payload.issues);
      if (lastConfigIssuesSignatureRef.current === signature) {
        return;
      }
      lastConfigIssuesSignatureRef.current = signature;

      void queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() });
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
            void queryClient
              .ensureQueryData(serverConfigQueryOptions())
              .then((config) =>
                api.shell.openInEditor(config.keybindingsConfigPath, preferredTerminalEditor()),
              )
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
    });
    return () => {
      disposed = true;
      unsubDomainEvent();
      unsubTerminalEvent();
      unsubWelcome();
      unsubServerConfigUpdated();
    };
  }, [
    navigate,
    queryClient,
    removeOrphanedTerminalStates,
    setProjectExpanded,
    syncServerReadModel,
  ]);

  return null;
}

function DesktopProjectBootstrap() {
  const projects = useStore((store) => store.projects);
  const threads = useStore((store) => store.threads);
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const setProjectExpanded = useStore((store) => store.setProjectExpanded);
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const setProjectDraftThreadId = useComposerDraftStore((store) => store.setProjectDraftThreadId);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
  );
  const navigate = useNavigate();
  const routeThreadId = useParams({
    strict: false,
    select: (params) => (params.threadId ? ThreadId.makeUnsafe(params.threadId) : null),
  });
  const [launcherState, setLauncherState] = useState<DesktopLauncherState | null>(null);
  const [launcherPromptDismissed, setLauncherPromptDismissed] = useState(false);
  const [installWithPathUpdate, setInstallWithPathUpdate] = useState(true);
  const [isInstallingLauncher, setIsInstallingLauncher] = useState(false);
  const projectOpenInFlightRef = useRef(false);
  const queuedProjectOpenPathRef = useRef<string | null>(null);
  const lastHandledProjectOpenRef = useRef<{ path: string; at: number } | null>(null);

  const handleNewThread = useCallback(
    (
      projectId: ProjectId,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
      },
    ): Promise<void> => {
      const hasBranchOption = options?.branch !== undefined;
      const hasWorktreePathOption = options?.worktreePath !== undefined;
      const hasEnvModeOption = options?.envMode !== undefined;
      const storedDraftThread = getDraftThreadByProjectId(projectId);
      if (storedDraftThread) {
        return (async () => {
          if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
            setDraftThreadContext(storedDraftThread.threadId, {
              ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
              ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
              ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
            });
          }
          setProjectDraftThreadId(projectId, storedDraftThread.threadId);
          if (routeThreadId === storedDraftThread.threadId) {
            return;
          }
          await navigate({
            to: "/$threadId",
            params: { threadId: storedDraftThread.threadId },
          });
        })();
      }
      clearProjectDraftThreadId(projectId);

      const activeDraftThread = routeThreadId ? getDraftThread(routeThreadId) : null;
      if (activeDraftThread && routeThreadId && activeDraftThread.projectId === projectId) {
        if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
          setDraftThreadContext(routeThreadId, {
            ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
            ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
            ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
          });
        }
        setProjectDraftThreadId(projectId, routeThreadId);
        return Promise.resolve();
      }

      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      return (async () => {
        setProjectDraftThreadId(projectId, threadId, {
          createdAt,
          branch: options?.branch ?? null,
          worktreePath: options?.worktreePath ?? null,
          envMode: options?.envMode ?? "local",
          runtimeMode: DEFAULT_RUNTIME_MODE,
        });

        await navigate({
          to: "/$threadId",
          params: { threadId },
        });
      })();
    },
    [
      clearProjectDraftThreadId,
      getDraftThread,
      getDraftThreadByProjectId,
      navigate,
      routeThreadId,
      setDraftThreadContext,
      setProjectDraftThreadId,
    ],
  );

  const focusMostRecentThreadForProject = useCallback(
    (projectId: ProjectId) => {
      const latestThread = threads
        .filter((thread) => thread.projectId === projectId)
        .toSorted((a, b) => {
          const byDate = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
          if (byDate !== 0) return byDate;
          return b.id.localeCompare(a.id);
        })[0];
      if (!latestThread) return false;

      void navigate({
        to: "/$threadId",
        params: { threadId: latestThread.id },
      });
      return true;
    },
    [navigate, threads],
  );

  const openProjectFromPath = useCallback(
    async (rawCwd: string) => {
      const cwd = rawCwd.trim();
      if (!cwd || projectOpenInFlightRef.current) return;
      const api = readNativeApi();
      if (!api) return;

      projectOpenInFlightRef.current = true;
      try {
        const existingProject = projects.find((project) => workspacePathsMatch(project.cwd, cwd));
        if (existingProject) {
          setProjectExpanded(existingProject.id, true);
          if (!focusMostRecentThreadForProject(existingProject.id)) {
            await handleNewThread(existingProject.id).catch(() => undefined);
          }
          return;
        }

        const projectId = newProjectId();
        const createdAt = new Date().toISOString();
        const title = cwd.split(/[/\\]/).findLast((entry) => entry.trim().length > 0) ?? cwd;
        await api.orchestration.dispatchCommand({
          type: "project.create",
          commandId: newCommandId(),
          projectId,
          title,
          workspaceRoot: cwd,
          defaultModel: DEFAULT_MODEL_BY_PROVIDER.codex,
          createdAt,
        });
        setProjectExpanded(projectId, true);
        await handleNewThread(projectId).catch(() => undefined);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Unable to open project from terminal",
          description:
            error instanceof Error ? error.message : "An error occurred while opening the project.",
        });
      } finally {
        projectOpenInFlightRef.current = false;
        void window.desktopBridge?.clearPendingProjectPath?.().catch(() => undefined);
      }
    },
    [focusMostRecentThreadForProject, handleNewThread, projects, setProjectExpanded],
  );

  const processIncomingProjectPath = useCallback(
    (cwd: string) => {
      const previous = lastHandledProjectOpenRef.current;
      const now = Date.now();
      if (previous && previous.path === cwd && now - previous.at < 1_000) {
        return;
      }
      lastHandledProjectOpenRef.current = { path: cwd, at: now };
      void openProjectFromPath(cwd);
    },
    [openProjectFromPath],
  );

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.onProjectOpen !== "function" ||
      typeof bridge.getPendingProjectPath !== "function"
    ) {
      return;
    }

    let disposed = false;
    const handleIncomingProjectPath = (cwd: string) => {
      if (!threadsHydrated) {
        queuedProjectOpenPathRef.current = cwd;
        return;
      }
      processIncomingProjectPath(cwd);
    };

    const unsubscribe = bridge.onProjectOpen((cwd) => {
      if (disposed) return;
      handleIncomingProjectPath(cwd);
    });

    void bridge
      .getPendingProjectPath()
      .then((cwd) => {
        if (disposed || !cwd) return;
        handleIncomingProjectPath(cwd);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [processIncomingProjectPath, threadsHydrated]);

  useEffect(() => {
    if (!threadsHydrated) {
      return;
    }

    const queuedProjectPath = queuedProjectOpenPathRef.current;
    if (!queuedProjectPath) {
      return;
    }

    queuedProjectOpenPathRef.current = null;
    processIncomingProjectPath(queuedProjectPath);
  }, [processIncomingProjectPath, threadsHydrated]);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getLauncherState !== "function" ||
      typeof bridge.onLauncherState !== "function"
    ) {
      return;
    }

    let disposed = false;
    let receivedSubscriptionUpdate = false;
    const unsubscribe = bridge.onLauncherState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      setLauncherState(nextState);
    });

    void bridge
      .getLauncherState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
        setLauncherState(nextState);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (launcherState?.status === "installed") {
      setLauncherPromptDismissed(true);
      return;
    }

    if (launcherState && !launcherState.pathConfigured) {
      setInstallWithPathUpdate(true);
    }
  }, [launcherState]);

  const shouldShowLauncherPrompt =
    launcherState !== null &&
    (launcherState.status === "missing" ||
      launcherState.status === "needs-path" ||
      launcherState.status === "error") &&
    !launcherPromptDismissed;

  const installButtonLabel =
    launcherState?.status === "needs-path" ? "Finish t3 setup" : "Install t3 command";

  const promptTitle =
    launcherState?.status === "needs-path"
      ? "Finish setting up t3"
      : "Install the t3 command";

  const promptDescription =
    launcherState?.status === "needs-path"
      ? "T3 Code already wrote the launcher, but your shell still needs PATH access before `t3` works in Terminal."
      : "Open the current project from Terminal with `t3 .` or jump into any workspace with `t3 <path>`.";

  const handleInstallLauncher = () => {
    const bridge = window.desktopBridge;
    if (!bridge || !launcherState || typeof bridge.installLauncher !== "function") {
      return;
    }

    setIsInstallingLauncher(true);
    void bridge
      .installLauncher({ updatePath: installWithPathUpdate })
      .then((result) => {
        setLauncherState(result.state);
        if (!result.completed || result.state.status === "error") {
          toastManager.add({
            type: "error",
            title: "Unable to install t3",
            description: result.state.message ?? "An unexpected error occurred during install.",
          });
          return;
        }

        if (result.state.status === "installed") {
          setLauncherPromptDismissed(true);
          toastManager.add({
            type: "success",
            title: "t3 is ready",
            description: "Open this workspace with `t3 .` from Terminal.",
          });
          return;
        }

        toastManager.add({
          type: "warning",
          title: "t3 needs one more step",
          description:
            result.state.message ??
            "Add the launcher directory to PATH so the command is available in new terminals.",
        });
      })
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: "Unable to install t3",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      })
      .finally(() => {
        setIsInstallingLauncher(false);
      });
  };

  return (
    <Dialog
      open={shouldShowLauncherPrompt}
      onOpenChange={(open) => {
        if (!open) {
          setLauncherPromptDismissed(true);
        }
      }}
    >
      <DialogPopup className="max-w-xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{promptTitle}</DialogTitle>
          <DialogDescription>{promptDescription}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="rounded-xl border border-border/70 bg-muted/45 p-4">
            <p className="text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">
              Terminal examples
            </p>
            <pre className="mt-3 overflow-x-auto text-sm leading-6 text-foreground">
{`t3 .
t3 ../my-app`}
            </pre>
          </div>

          <label className="flex items-start gap-3 rounded-xl border border-border/70 bg-background/70 p-4">
            <Checkbox
              checked={installWithPathUpdate}
              onCheckedChange={(checked) => {
                setInstallWithPathUpdate(checked === true);
              }}
            />
            <span className="space-y-1">
              <span className="block text-sm font-medium text-foreground">
                Add {launcherState?.installDir ?? "~/.t3/bin"} to PATH
              </span>
              <span className="block text-sm text-muted-foreground">
                {launcherState?.pathUpdateTarget
                  ? `T3 Code will update ${launcherState.pathUpdateTarget} so new terminals can find \`t3\`.`
                  : "T3 Code will update your shell PATH so new terminals can find `t3`."}
              </span>
            </span>
          </label>

          {launcherState?.message ? (
            <p className="text-sm text-muted-foreground">{launcherState.message}</p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={isInstallingLauncher}
            onClick={() => {
              setLauncherPromptDismissed(true);
            }}
          >
            Not now
          </Button>
          <Button disabled={isInstallingLauncher} onClick={handleInstallLauncher}>
            {isInstallingLauncher ? "Installing..." : installButtonLabel}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
