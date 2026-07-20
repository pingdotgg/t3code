import type {
  OrchestrationEvent,
  WorkflowArtifact,
  WorkflowArtifactId,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunId,
} from "@t3tools/contracts";

export interface WorkflowRuntimeState {
  readonly runsById: Readonly<Record<WorkflowRunId, WorkflowRun>>;
  readonly definitionsByRunId: Readonly<Record<WorkflowRunId, WorkflowDefinition>>;
  readonly artifactsById: Readonly<Record<WorkflowArtifactId, WorkflowArtifact>>;
  readonly artifactIdsByRunId: Readonly<Record<WorkflowRunId, readonly WorkflowArtifactId[]>>;
}

export const EMPTY_WORKFLOW_RUNTIME_STATE: WorkflowRuntimeState = Object.freeze({
  runsById: {},
  definitionsByRunId: {},
  artifactsById: {},
  artifactIdsByRunId: {},
});

type WorkflowRunPresentation = {
  readonly run: WorkflowRun;
  readonly definition: WorkflowDefinition | undefined;
  readonly artifacts: ReadonlyArray<WorkflowArtifact>;
};

const workflowRunPresentationsByRuntimeState = new WeakMap<
  WorkflowRuntimeState,
  Map<WorkflowRun["parentThreadId"], ReadonlyArray<WorkflowRunPresentation>>
>();

export function createWorkflowRuntimeState(
  runs: ReadonlyArray<{
    readonly run: WorkflowRun;
    readonly definition: WorkflowDefinition;
  }> = [],
  artifacts: ReadonlyArray<WorkflowArtifact> = [],
): WorkflowRuntimeState {
  if (runs.length === 0 && artifacts.length === 0) {
    return EMPTY_WORKFLOW_RUNTIME_STATE;
  }

  const artifactIdsByRunId: Record<WorkflowRunId, WorkflowArtifactId[]> = {};
  for (const artifact of artifacts) {
    (artifactIdsByRunId[artifact.runId] ??= []).push(artifact.id);
  }

  return {
    runsById: Object.fromEntries(runs.map(({ run }) => [run.id, run])) as Record<
      WorkflowRunId,
      WorkflowRun
    >,
    definitionsByRunId: Object.fromEntries(
      runs.map(({ run, definition }) => [run.id, definition]),
    ) as Record<WorkflowRunId, WorkflowDefinition>,
    artifactsById: Object.fromEntries(
      artifacts.map((artifact) => [artifact.id, artifact]),
    ) as Record<WorkflowArtifactId, WorkflowArtifact>,
    artifactIdsByRunId,
  };
}

export function applyWorkflowRuntimeEvent(
  state: WorkflowRuntimeState,
  event: OrchestrationEvent,
): WorkflowRuntimeState {
  switch (event.type) {
    case "workflow.run-requested":
      return {
        ...state,
        runsById: { ...state.runsById, [event.payload.run.id]: event.payload.run },
        definitionsByRunId: {
          ...state.definitionsByRunId,
          [event.payload.run.id]: event.payload.definition,
        },
      };

    case "workflow.artifact-created":
      return upsertArtifact(state, event.payload.artifact);

    case "workflow.node-worker-started":
      return updateRun(state, event.payload.runId, (run) => ({
        ...run,
        status: "running",
        nodes: run.nodes.map((node) =>
          node.nodeId === event.payload.nodeId
            ? {
                ...node,
                status: "running",
                workerThreadId: event.payload.workerThreadId,
                startedAt: event.payload.startedAt,
              }
            : node,
        ),
        updatedAt: event.occurredAt,
      }));

    case "workflow.worker-result-recorded": {
      const nextState = upsertArtifact(state, event.payload.artifact);
      const nodeId = event.payload.artifact.nodeId;
      if (!nodeId || event.payload.artifact.payload.kind !== "worker-result") {
        return nextState;
      }
      const status = event.payload.artifact.payload.status;
      return updateRun(nextState, event.payload.runId, (run) => ({
        ...run,
        nodes: run.nodes.map((node) =>
          node.nodeId === nodeId
            ? {
                ...node,
                status,
                resultArtifactId: event.payload.artifact.id,
                completedAt: event.payload.completedAt,
              }
            : node,
        ),
        updatedAt: event.occurredAt,
      }));
    }

    case "workflow.run-finalized": {
      const nextState = upsertArtifact(state, event.payload.artifact);
      return updateRun(nextState, event.payload.runId, (run) => ({
        ...run,
        status: event.payload.status,
        nodes:
          event.payload.status === "failed"
            ? run.nodes.map((node) =>
                node.status === "pending"
                  ? {
                      ...node,
                      status: "failed",
                      completedAt: event.payload.completedAt,
                    }
                  : node,
              )
            : run.nodes,
        finalArtifactId: event.payload.artifact.id,
        updatedAt: event.payload.completedAt,
        completedAt: event.payload.completedAt,
      }));
    }

    default:
      return state;
  }
}

export function selectWorkflowRunsForParentThread(
  state: WorkflowRuntimeState,
  parentThreadId: WorkflowRun["parentThreadId"],
): ReadonlyArray<WorkflowRunPresentation> {
  let presentationsByParentThreadId = workflowRunPresentationsByRuntimeState.get(state);
  if (!presentationsByParentThreadId) {
    presentationsByParentThreadId = new Map();
    workflowRunPresentationsByRuntimeState.set(state, presentationsByParentThreadId);
  }

  const cached = presentationsByParentThreadId.get(parentThreadId);
  if (cached) {
    return cached;
  }

  const presentations = Object.values(state.runsById)
    .filter((run) => run.parentThreadId === parentThreadId)
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((run) => ({
      run,
      definition: state.definitionsByRunId[run.id],
      artifacts: (state.artifactIdsByRunId[run.id] ?? []).flatMap((artifactId) => {
        const artifact = state.artifactsById[artifactId];
        return artifact ? [artifact] : [];
      }),
    }));
  presentationsByParentThreadId.set(parentThreadId, presentations);
  return presentations;
}

function updateRun(
  state: WorkflowRuntimeState,
  runId: WorkflowRunId,
  update: (run: WorkflowRun) => WorkflowRun,
): WorkflowRuntimeState {
  const run = state.runsById[runId];
  if (!run) {
    return state;
  }

  return {
    ...state,
    runsById: { ...state.runsById, [runId]: update(run) },
  };
}

function upsertArtifact(
  state: WorkflowRuntimeState,
  artifact: WorkflowArtifact,
): WorkflowRuntimeState {
  const existing = state.artifactsById[artifact.id];
  const artifactIds = state.artifactIdsByRunId[artifact.runId] ?? [];
  const nextArtifactIds =
    existing || artifactIds.includes(artifact.id) ? artifactIds : [...artifactIds, artifact.id];

  return {
    ...state,
    artifactsById: { ...state.artifactsById, [artifact.id]: artifact },
    artifactIdsByRunId:
      nextArtifactIds === artifactIds
        ? state.artifactIdsByRunId
        : { ...state.artifactIdsByRunId, [artifact.runId]: nextArtifactIds },
  };
}
