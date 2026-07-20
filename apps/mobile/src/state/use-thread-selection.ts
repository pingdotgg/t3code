import { useRoute, type RouteProp } from "@react-navigation/native";
import { useMemo, useRef } from "react";
import {
  EnvironmentId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  presentThreadShell,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import * as Option from "effect/Option";
import { copySorted } from "@t3tools/shared/Array";

import { useProject, useThreadShell } from "../state/entities";
import { useEnvironmentThread } from "../state/threads";
import {
  useRemoteEnvironmentRuntime,
  useSavedRemoteConnection,
} from "./use-remote-environment-registry";
type ThreadSelectionRouteParams = {
  readonly environmentId?: string | string[];
  readonly threadId?: string | string[];
};

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function latestUserMessageAt(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadShell["latestUserMessageAt"] {
  for (let index = projection.messages.length - 1; index >= 0; index -= 1) {
    const message = projection.messages[index];
    if (message?.role === "user") {
      return message.createdAt;
    }
  }

  return null;
}

/**
 * Builds an optimistic thread shell from the detail projection for the window
 * where the shell list has not materialized the thread yet (e.g. a thread that
 * was just created from this device).
 */
function threadDetailToShell(
  environmentId: EnvironmentId,
  projection: OrchestrationV2ThreadProjection,
): EnvironmentThreadShell {
  const thread = projection.thread;
  const runsByOrdinal = copySorted(projection.runs, (left, right) => right.ordinal - left.ordinal);
  const latestRun = runsByOrdinal[0] ?? null;
  const activeRun =
    runsByOrdinal.find(
      (run) =>
        run.status === "preparing" ||
        run.status === "queued" ||
        run.status === "starting" ||
        run.status === "running" ||
        run.status === "waiting",
    ) ?? null;
  const pendingRequest =
    projection.runtimeRequests.find((request) => request.status === "pending") ?? null;
  return presentThreadShell(environmentId, {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    providerInstanceId: thread.providerInstanceId,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    activeProviderThreadId: thread.activeProviderThreadId,
    lineage: thread.lineage,
    forkedFrom: thread.forkedFrom,
    createdBy: thread.createdBy,
    creationSource: thread.creationSource,
    latestRunId: latestRun?.id ?? null,
    activeRunId: activeRun?.id ?? null,
    status: activeRun?.status ?? latestRun?.status ?? "idle",
    pendingRuntimeRequest:
      pendingRequest === null
        ? null
        : { id: pendingRequest.id, kind: pendingRequest.kind, createdAt: pendingRequest.createdAt },
    latestVisibleMessage: null,
    latestUserMessageAt: latestUserMessageAt(projection),
    hasActionableProposedPlan: false,
    itemCount: projection.turnItems.length,
    visibleItemCount: projection.visibleTurnItems.length,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    deletedAt: thread.deletedAt,
  });
}

function useResolvedThreadSelection(params: ThreadSelectionRouteParams | undefined) {
  const routeParams = params ?? {};
  const routeThreadRef = useMemo<ScopedThreadRef | null>(() => {
    const environmentId = firstRouteParam(routeParams.environmentId);
    const threadId = firstRouteParam(routeParams.threadId);
    if (!environmentId || !threadId) {
      return null;
    }

    return {
      environmentId: EnvironmentId.make(environmentId),
      threadId: ThreadId.make(threadId),
    };
  }, [routeParams.environmentId, routeParams.threadId]);
  const lastRouteThreadRef = useRef<ScopedThreadRef | null>(null);
  if (routeThreadRef !== null) {
    lastRouteThreadRef.current = routeThreadRef;
  }
  const selectedThreadRef = routeThreadRef ?? lastRouteThreadRef.current;
  const selectedThreadShell = useThreadShell(selectedThreadRef);
  const selectedThreadDetailState = useEnvironmentThread(
    selectedThreadRef?.environmentId ?? null,
    selectedThreadRef?.threadId ?? null,
  );
  const selectedThreadDetail = Option.getOrNull(selectedThreadDetailState.data);
  const selectedThread = useMemo(
    () =>
      selectedThreadShell ??
      (selectedThreadRef !== null && selectedThreadDetail !== null
        ? threadDetailToShell(selectedThreadRef.environmentId, selectedThreadDetail)
        : null),
    [selectedThreadDetail, selectedThreadRef, selectedThreadShell],
  );
  const selectedProjectRef = useMemo<ScopedProjectRef | null>(
    () =>
      selectedThread === null
        ? null
        : {
            environmentId: selectedThread.environmentId,
            projectId: selectedThread.projectId,
          },
    [selectedThread],
  );
  const selectedThreadProject = useProject(selectedProjectRef);
  const selectedEnvironmentId = selectedThread?.environmentId ?? null;
  const selectedEnvironmentConnection = useSavedRemoteConnection(selectedEnvironmentId);
  const selectedEnvironmentRuntime = useRemoteEnvironmentRuntime(selectedEnvironmentId);

  return useMemo(
    () => ({
      selectedThreadRef,
      selectedThread,
      selectedThreadProject,
      selectedEnvironmentConnection,
      selectedEnvironmentRuntime,
    }),
    [
      selectedEnvironmentConnection,
      selectedEnvironmentRuntime,
      selectedThread,
      selectedThreadProject,
      selectedThreadRef,
    ],
  );
}

type ThreadSelectionState = ReturnType<typeof useResolvedThreadSelection>;

export function useThreadSelection(): ThreadSelectionState {
  const route = useRoute<RouteProp<Record<string, ThreadSelectionRouteParams | undefined>>>();
  return useResolvedThreadSelection(route.params);
}
