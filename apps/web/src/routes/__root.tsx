import { Outlet, createRootRouteWithContext, useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { QueryClient, useQueryClient } from "@tanstack/react-query";

import { AnchoredToastProvider, ToastProvider } from "../components/ui/toast";
import { isElectron } from "../env";
import { useNativeApi } from "../hooks/useNativeApi";
import { invalidateGitQueries } from "../lib/gitReactQuery";
import { DEFAULT_MODEL } from "../model-logic";
import { useStore } from "../store";
import { onServerWelcome } from "../wsNativeApi";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootRouteView,
});

function RootRouteView() {
  const api = useNativeApi();

  if (!api) {
    return (
      <div className="flex h-screen flex-col bg-background text-foreground">
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">Connecting to T3 Code server...</p>
        </div>
      </div>
    );
  }

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <EventRouter />
        <AutoProjectBootstrap />
        <DesktopProjectBootstrap />
        <Outlet />
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function EventRouter() {
  const api = useNativeApi();
  const { dispatch } = useStore();
  const queryClient = useQueryClient();
  const activeAssistantItemRef = useRef<string | null>(null);
  const activeThreadId = useParams({
    strict: false,
    select: (params) => params.threadId,
  });

  useEffect(() => {
    if (!api) return;
    return api.providers.onEvent((event) => {
      if (event.method === "turn/completed") {
        void invalidateGitQueries(queryClient);
      }
      if (!activeThreadId) return;
      dispatch({
        type: "APPLY_EVENT",
        event,
        activeAssistantItemRef,
        activeThreadId,
      });
    });
  }, [activeThreadId, api, dispatch, queryClient]);

  useEffect(() => {
    if (!api) return;
    return api.terminal.onEvent((event) => {
      dispatch({
        type: "APPLY_TERMINAL_EVENT",
        event,
      });
    });
  }, [api, dispatch]);

  return null;
}

function AutoProjectBootstrap() {
  const { state, dispatch } = useStore();
  const bootstrappedRef = useRef(false);

  useEffect(() => {
    // Browser mode bootstraps from server welcome.
    // Electron bootstraps from persisted projects via DesktopProjectBootstrap.
    if (isElectron) return;

    return onServerWelcome((payload) => {
      if (bootstrappedRef.current) return;

      // Don't create duplicate projects for the same cwd
      const existing = state.projects.find((project) => project.cwd === payload.cwd);
      if (existing) {
        bootstrappedRef.current = true;
        dispatch({ type: "SET_THREADS_HYDRATED", hydrated: true });
        return;
      }

      bootstrappedRef.current = true;

      // Create project + thread from server cwd
      const projectId = crypto.randomUUID();
      dispatch({
        type: "ADD_PROJECT",
        project: {
          id: projectId,
          name: payload.projectName,
          cwd: payload.cwd,
          model: DEFAULT_MODEL,
          expanded: true,
          scripts: [],
        },
      });
      dispatch({ type: "SET_THREADS_HYDRATED", hydrated: true });
    });
  }, [state.projects, dispatch]);

  return null;
}

function DesktopProjectBootstrap() {
  const api = useNativeApi();
  const { dispatch } = useStore();
  const bootstrappedRef = useRef(false);

  useEffect(() => {
    if (!isElectron || !api || bootstrappedRef.current) return;

    let disposed = false;
    let retryDelayMs = 500;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const attemptBootstrap = async () => {
      try {
        const projects = await api.projects.list();
        if (disposed) return;
        dispatch({
          type: "SYNC_PROJECTS",
          projects: projects.map((project) => ({
            id: project.id,
            name: project.name,
            cwd: project.cwd,
            model: DEFAULT_MODEL,
            expanded: true,
            scripts: project.scripts,
          })),
        });
        dispatch({ type: "SET_THREADS_HYDRATED", hydrated: true });
        bootstrappedRef.current = true;
      } catch {
        if (disposed) return;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void attemptBootstrap();
        }, retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 5_000);
      }
    };

    void attemptBootstrap();

    return () => {
      disposed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }, [api, dispatch]);

  return null;
}
