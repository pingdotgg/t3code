import type { EnvironmentApi, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import { toastManager } from "../components/ui/toast";
import { readEnvironmentApi } from "../environmentApi";
import { readPrimaryEnvironmentDescriptor } from "../environments/primary";
import { ensureEnvironmentConnectionBootstrapped } from "../environments/runtime";
import { openProjectByPath, type OpenProjectByPathInput } from "../lib/openProjectByPath";
import { selectEnvironmentState, selectProjectsForEnvironment, useStore } from "../store";

type Toaster = (params: {
  readonly type: "error";
  readonly title: string;
  readonly description: string;
}) => unknown;

interface ProjectSnapshot {
  readonly projects: OpenProjectByPathInput["projects"];
  readonly threads: OpenProjectByPathInput["threads"];
}

export interface DesktopOpenProjectPathHandlerDeps {
  readonly path: string;
  readonly isDisposed: () => boolean;
  readonly sidebarThreadSortOrder: OpenProjectByPathInput["sidebarThreadSortOrder"];
  readonly defaultThreadEnvMode: OpenProjectByPathInput["defaultThreadEnvMode"];
  readonly navigate: OpenProjectByPathInput["navigate"];
  readonly handleNewThread: OpenProjectByPathInput["handleNewThread"];
  // Injectable for tests; production uses the defaults below.
  readonly readPrimaryEnvironmentId?: () => EnvironmentId | null;
  readonly ensureBootstrapped?: (environmentId: EnvironmentId) => Promise<void>;
  readonly readApi?: (
    environmentId: EnvironmentId,
  ) => Pick<EnvironmentApi, "orchestration"> | undefined;
  readonly readProjectSnapshot?: (environmentId: EnvironmentId) => ProjectSnapshot;
  readonly dispatch?: (input: OpenProjectByPathInput) => Promise<void>;
  readonly toast?: Toaster;
}

function defaultReadPrimaryEnvironmentId(): EnvironmentId | null {
  return readPrimaryEnvironmentDescriptor()?.environmentId ?? null;
}

function defaultToast(params: Parameters<Toaster>[0]): void {
  toastManager.add(params);
}

function defaultReadProjectSnapshot(environmentId: EnvironmentId): ProjectSnapshot {
  const state = useStore.getState();
  const environmentState = selectEnvironmentState(state, environmentId);
  return {
    projects: selectProjectsForEnvironment(state, environmentId),
    threads: environmentState.threadIds.flatMap((threadId) => {
      const thread = environmentState.sidebarThreadSummaryById[threadId];
      return thread ? [thread] : [];
    }),
  };
}

/**
 * The body of the `onOpenProjectPath` listener, extracted so the async
 * sequencing (await bootstrap → check disposed → resolve fresh state → dispatch)
 * can be covered by a plain unit test without mounting React.
 */
export async function runDesktopOpenProjectPathHandler(
  deps: DesktopOpenProjectPathHandlerDeps,
): Promise<void> {
  const readEnvId = deps.readPrimaryEnvironmentId ?? defaultReadPrimaryEnvironmentId;
  const ensureBootstrapped = deps.ensureBootstrapped ?? ensureEnvironmentConnectionBootstrapped;
  const readApi = deps.readApi ?? readEnvironmentApi;
  const readProjectSnapshot = deps.readProjectSnapshot ?? defaultReadProjectSnapshot;
  const dispatch = deps.dispatch ?? openProjectByPath;
  const toast = deps.toast ?? defaultToast;

  const reportError = (error: unknown): void => {
    toast({
      type: "error",
      title: "Failed to open project",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  };

  try {
    const environmentId = readEnvId();
    if (!environmentId) return;
    await ensureBootstrapped(environmentId);
    if (deps.isDisposed()) return;
    const snapshot = readProjectSnapshot(environmentId);
    const api = readApi(environmentId);
    if (!api) return;
    await dispatch({
      environmentId,
      path: deps.path,
      api,
      projects: snapshot.projects,
      threads: snapshot.threads,
      sidebarThreadSortOrder: deps.sidebarThreadSortOrder,
      defaultThreadEnvMode: deps.defaultThreadEnvMode,
      navigate: deps.navigate,
      handleNewThread: deps.handleNewThread,
      onError: reportError,
    });
  } catch (error) {
    reportError(error);
  }
}

type UseDesktopOpenProjectPathSubscriptionInput = Omit<
  DesktopOpenProjectPathHandlerDeps,
  | "path"
  | "readPrimaryEnvironmentId"
  | "ensureBootstrapped"
  | "readApi"
  | "readProjectSnapshot"
  | "dispatch"
  | "toast"
>;

/**
 * Wires `desktopBridge.onOpenProjectPath` — the channel desktop main fires
 * on second-instance / `open-file` — to `runDesktopOpenProjectPathHandler`.
 */
export function useDesktopOpenProjectPathSubscription(
  input: UseDesktopOpenProjectPathSubscriptionInput,
): void {
  const handleEvent = useEffectEvent((path: string) => {
    void runDesktopOpenProjectPathHandler({ ...input, path });
  });

  useEffect(() => {
    const onOpenProjectPath = window.desktopBridge?.onOpenProjectPath;
    if (typeof onOpenProjectPath !== "function") return;
    const unsubscribe = onOpenProjectPath((path) => {
      handleEvent(path);
    });
    return () => {
      unsubscribe?.();
    };
  }, []);
}
