import {
  Outlet,
  createRootRouteWithContext,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { QueryClient } from "@tanstack/react-query";

import { APP_DISPLAY_NAME } from "../branding";
import { Button } from "../components/ui/button";
import { AnchoredToastProvider, ToastProvider } from "../components/ui/toast";
import { isElectron } from "../env";
import { useNativeApi } from "../hooks/useNativeApi";
import { DEFAULT_MODEL } from "../model-logic";
import { useStore } from "../store";
import { onServerWelcome } from "../wsNativeApi";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
});

function RootRouteView() {
  const api = useNativeApi();

  if (!api) {
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
        <AutoProjectBootstrap />
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
  const api = useNativeApi();
  const { dispatch } = useStore();

  useEffect(() => {
    if (!api) return;
    void api.orchestration
      .getSnapshot()
      .then((snapshot) => {
        dispatch({ type: "SYNC_SERVER_READ_MODEL", readModel: snapshot });
      })
      .catch(() => undefined);
    const unsubReadModel = api.orchestration.onReadModel((snapshot) => {
      dispatch({ type: "SYNC_SERVER_READ_MODEL", readModel: snapshot });
    });
    return () => {
      unsubReadModel();
    };
  }, [api, dispatch]);

  return null;
}

function AutoProjectBootstrap() {
  const api = useNativeApi();
  const { state, dispatch } = useStore();
  const bootstrappedRef = useRef(false);

  useEffect(() => {
    if (!api) return;
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
      const projectId = crypto.randomUUID();
      const threadId = crypto.randomUUID();
      const now = new Date().toISOString();
      void api.orchestration
        .dispatchCommand({
          type: "project.create",
          commandId: crypto.randomUUID(),
          projectId,
          name: payload.projectName,
          cwd: payload.cwd,
          model: DEFAULT_MODEL,
          createdAt: now,
        })
        .then(() =>
          api.orchestration.dispatchCommand({
            type: "thread.create",
            commandId: crypto.randomUUID(),
            threadId,
            projectId,
            title: "New thread",
            model: DEFAULT_MODEL,
            branch: null,
            worktreePath: null,
            createdAt: now,
          }),
        )
        .catch(() => undefined);
    });
  }, [api, state.projects, dispatch]);

  return null;
}

function DesktopProjectBootstrap() {
  // Desktop now hydrates from orchestration read-model snapshots.
  return null;
}
