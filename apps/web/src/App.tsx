import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Suspense, lazy, useEffect, useRef } from "react";

import ChatView from "./components/ChatView";
import Sidebar from "./components/Sidebar";
import { isElectron } from "./env";
import { DEFAULT_MODEL } from "./model-logic";
import { StoreProvider, useStore } from "./store";
import { DEFAULT_THREAD_TERMINAL_HEIGHT, DEFAULT_THREAD_TERMINAL_ID } from "./types";
import { onServerWelcome } from "./wsNativeApi";
import { useNativeApi } from "./hooks/useNativeApi";
import { AnchoredToastProvider, ToastProvider } from "./components/ui/toast";
import { invalidateGitQueries } from "./lib/gitReactQuery";

const DiffPanel = lazy(() => import("./components/DiffPanel"));

function EventRouter() {
  const api = useNativeApi();
  const { dispatch } = useStore();
  const queryClient = useQueryClient();
  const activeAssistantItemRef = useRef<string | null>(null);

  useEffect(() => {
    if (!api) return;
    return api.providers.onEvent((event) => {
      if (event.method === "turn/completed") {
        void invalidateGitQueries(queryClient);
      }
      dispatch({
        type: "APPLY_EVENT",
        event,
        activeAssistantItemRef,
      });
    });
  }, [api, dispatch, queryClient]);

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
      const existing = state.projects.find((p) => p.cwd === payload.cwd);
      if (existing) {
        bootstrappedRef.current = true;
        // Ensure a thread is active
        const existingThread = state.threads.find((t) => t.projectId === existing.id);
        if (existingThread && !state.activeThreadId) {
          dispatch({
            type: "SET_ACTIVE_THREAD",
            threadId: existingThread.id,
          });
        }
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
      dispatch({
        type: "ADD_THREAD",
        thread: {
          id: crypto.randomUUID(),
          codexThreadId: null,
          projectId,
          title: "New thread",
          model: DEFAULT_MODEL,
          terminalOpen: false,
          terminalHeight: DEFAULT_THREAD_TERMINAL_HEIGHT,
          terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
          runningTerminalIds: [],
          activeTerminalId: DEFAULT_THREAD_TERMINAL_ID,
          terminalGroups: [
            {
              id: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
              terminalIds: [DEFAULT_THREAD_TERMINAL_ID],
            },
          ],
          activeTerminalGroupId: `group-${DEFAULT_THREAD_TERMINAL_ID}`,
          session: null,
          messages: [],
          events: [],
          error: null,
          createdAt: new Date().toISOString(),
          branch: null,
          worktreePath: null,
        },
      });
    });
  }, [state.projects, state.threads, state.activeThreadId, dispatch]);

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

function Layout() {
  const api = useNativeApi();
  const { state } = useStore();

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
    <div className="flex h-screen overflow-hidden bg-background text-foreground isolate">
      <EventRouter />
      <AutoProjectBootstrap />
      <DesktopProjectBootstrap />
      <Sidebar />
      <ChatView />
      {state.diffOpen && (
        <Suspense
          fallback={
            <aside className="flex h-full w-[560px] shrink-0 items-center justify-center border-l border-border bg-card px-4 text-center text-xs text-muted-foreground/70">
              Loading diff viewer...
            </aside>
          }
        >
          <DiffPanel />
        </Suspense>
      )}
    </div>
  );
}

const queryClient = new QueryClient();

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <StoreProvider>
        <ToastProvider>
          <AnchoredToastProvider>
            <Layout />
          </AnchoredToastProvider>
        </ToastProvider>
      </StoreProvider>
    </QueryClientProvider>
  );
}
