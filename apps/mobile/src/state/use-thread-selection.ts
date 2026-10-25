import { useAtomValue } from "@effect/atom-react";
import { useRoute, type RouteProp } from "@react-navigation/native";
import { useState } from "react";
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
import {
  deriveLatestThreadRun,
  deriveThreadRuntime,
} from "@t3tools/client-runtime/state/thread-execution";
import * as Option from "effect/Option";

import { scopedThreadKey } from "../lib/scopedEntities";
import { useProject, useQuietThreadShell } from "../state/entities";
import { useEnvironmentThread } from "../state/threads";
import {
  resolvePendingThreadCreation,
  pendingThreadCreationOutcomesAtom,
  pendingThreadCreationShell,
  type PendingThreadCreation,
} from "./pending-thread-creation";
import {
  useRemoteEnvironmentRuntime,
  useSavedRemoteConnection,
} from "./use-remote-environment-registry";
import { useThreadOutboxMessages } from "./use-thread-outbox";
type ThreadSelectionRouteParams = {
  readonly environmentId?: string | string[];
  readonly threadId?: string | string[];
};

function firstRouteParam(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first.trim().length === 0 ? null : first;
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

function threadDetailToShell(
  environmentId: EnvironmentId,
  projection: OrchestrationV2ThreadProjection,
): EnvironmentThreadShell {
  const thread = projection.thread;
  const latestRun = deriveLatestThreadRun(projection);
  const runtime = deriveThreadRuntime(projection);
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
    linkedPullRequest: thread.linkedPullRequest ?? null,
    pullRequests: thread.pullRequests,
    branchPullRequest: thread.branchPullRequest ?? null,
    activeProviderThreadId: thread.activeProviderThreadId,
    lineage: thread.lineage,
    forkedFrom: thread.forkedFrom,
    createdBy: thread.createdBy,
    creationSource: thread.creationSource,
    latestRunId: latestRun?.runId ?? null,
    activeRunId: runtime?.activeRunId ?? null,
    status: runtime?.status ?? "idle",
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
    settledOverride: thread.settledOverride,
    settledAt: thread.settledAt,
    unsettledAt: thread.unsettledAt,
    activeOrderKey: thread.activeOrderKey,
    autoSettleDisabledAt: thread.autoSettleDisabledAt,
    pinnedAt: thread.pinnedAt,
    pinOrderKey: thread.pinOrderKey,
    snoozedUntil: thread.snoozedUntil ?? null,
    snoozedAt: thread.snoozedAt ?? null,
    deletedAt: thread.deletedAt,
  });
}

function useResolvedThreadSelection(params: ThreadSelectionRouteParams | undefined) {
  const routeParams = params ?? {};
  const routeEnvironmentId = firstRouteParam(routeParams.environmentId);
  const routeThreadId = firstRouteParam(routeParams.threadId);
  // Retain the last complete thread ref while closing routes drop params.
  const [lastRouteThreadRef, setLastRouteThreadRef] = useState<ScopedThreadRef | null>(null);
  if (
    routeEnvironmentId !== null &&
    routeThreadId !== null &&
    (lastRouteThreadRef?.environmentId !== routeEnvironmentId ||
      lastRouteThreadRef.threadId !== routeThreadId)
  ) {
    setLastRouteThreadRef({
      environmentId: EnvironmentId.make(routeEnvironmentId),
      threadId: ThreadId.make(routeThreadId),
    });
  }
  const selectedThreadRef =
    routeEnvironmentId !== null && routeThreadId !== null
      ? lastRouteThreadRef?.environmentId === routeEnvironmentId &&
        lastRouteThreadRef.threadId === routeThreadId
        ? lastRouteThreadRef
        : {
            environmentId: EnvironmentId.make(routeEnvironmentId),
            threadId: ThreadId.make(routeThreadId),
          }
      : lastRouteThreadRef;
  const selectedThreadShell = useQuietThreadShell(selectedThreadRef);
  const selectedThreadKey =
    selectedThreadRef === null
      ? null
      : scopedThreadKey(selectedThreadRef.environmentId, selectedThreadRef.threadId);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const creationOutcome = useAtomValue(pendingThreadCreationOutcomesAtom);
  const pendingCreation = ((): PendingThreadCreation | null => {
    if (selectedThreadKey === null) {
      return null;
    }
    const queued = queuedMessagesByThreadKey[selectedThreadKey]?.find(
      (message) => message.creation !== undefined,
    );
    const outcome = creationOutcome[selectedThreadKey] ?? null;
    const message = queued ?? outcome?.message ?? null;
    return message === null ? null : { message, outcome };
  })();
  // The shell can arrive before creation is acknowledged. Wait for delivery
  // before subscribing: an early not-found is cached as a deleted thread.
  // Every detail reader must use this ref, not the route id.
  const selectedThreadDetailRef =
    pendingCreation === null || pendingCreation.outcome?.kind === "delivered"
      ? selectedThreadRef
      : null;
  const [previousCreation, setPreviousCreation] = useState<PendingThreadCreation | null>(null);
  const needsDetail =
    selectedThreadShell === null || pendingCreation !== null || previousCreation !== null;
  const selectedThreadDetailState = useEnvironmentThread(
    needsDetail ? (selectedThreadDetailRef?.environmentId ?? null) : null,
    needsDetail ? (selectedThreadDetailRef?.threadId ?? null) : null,
  );
  const selectedThreadDetail = Option.getOrNull(selectedThreadDetailState.data);
  const selectedThread =
    selectedThreadShell ??
    (selectedThreadRef !== null && selectedThreadDetail !== null
      ? threadDetailToShell(selectedThreadRef.environmentId, selectedThreadDetail)
      : pendingCreation !== null
        ? pendingThreadCreationShell(pendingCreation.message)
        : null);
  const resolvedCreation = resolvePendingThreadCreation({
    threadKey: selectedThreadKey,
    pending: pendingCreation,
    previous: previousCreation,
    detail: selectedThreadDetail,
  });
  // Compare pendingCreation contents; new render-time objects would otherwise continually set state.
  const creationUnchanged =
    resolvedCreation === previousCreation ||
    (resolvedCreation !== null &&
      previousCreation !== null &&
      resolvedCreation.message === previousCreation.message &&
      resolvedCreation.outcome === previousCreation.outcome);
  if (!creationUnchanged) {
    setPreviousCreation(resolvedCreation);
  }
  const selectedThreadCreation = creationUnchanged ? previousCreation : resolvedCreation;
  const selectedProjectRef: ScopedProjectRef | null =
    selectedThread === null
      ? null
      : {
          environmentId: selectedThread.environmentId,
          projectId: selectedThread.projectId,
        };
  const selectedThreadProject = useProject(selectedProjectRef);
  const selectedEnvironmentId = selectedThread?.environmentId ?? null;
  const selectedEnvironmentConnection = useSavedRemoteConnection(selectedEnvironmentId);
  const selectedEnvironmentRuntime = useRemoteEnvironmentRuntime(selectedEnvironmentId);

  return {
    selectedThreadRef,
    selectedThread,
    selectedThreadCreation,
    selectedThreadDetailRef,
    selectedThreadProject,
    selectedEnvironmentConnection,
    selectedEnvironmentRuntime,
  };
}

type ThreadSelectionState = ReturnType<typeof useResolvedThreadSelection>;

export function useThreadSelection(): ThreadSelectionState {
  const route = useRoute<RouteProp<Record<string, ThreadSelectionRouteParams | undefined>>>();
  return useResolvedThreadSelection(route.params);
}
