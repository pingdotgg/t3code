import {
  presentThread,
  presentThreadShell,
  type EnvironmentThread,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const DEFAULT_TIMESTAMP = "2026-01-01T00:00:00.000Z";

export function makeRawThreadShell(
  input: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  const id = input.id ?? ThreadId.make("thread-test");
  const providerInstanceId = input.providerInstanceId ?? ProviderInstanceId.make("codex");
  const now = DateTime.makeUnsafe(DEFAULT_TIMESTAMP);
  return {
    id,
    projectId: ProjectId.make("project-test"),
    title: "Thread",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "mobile",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    ...input,
  };
}

export function makeThreadShellFixture(
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  const environmentId = overrides.environmentId ?? EnvironmentId.make("environment-test");
  const raw = makeRawThreadShell({
    id: overrides.id,
    projectId: overrides.projectId,
    title: overrides.title,
    providerInstanceId: overrides.providerInstanceId,
    modelSelection: overrides.modelSelection,
    runtimeMode: overrides.runtimeMode,
    interactionMode: overrides.interactionMode,
    branch: overrides.branch,
    worktreePath: overrides.worktreePath,
  });
  return { ...presentThreadShell(environmentId, raw), ...overrides };
}

export function makeThreadFixture(overrides: Partial<EnvironmentThread> = {}): EnvironmentThread {
  const shell = makeRawThreadShell({
    id: overrides.id,
    projectId: overrides.projectId,
    title: overrides.title,
    providerInstanceId: overrides.providerInstanceId,
    modelSelection: overrides.modelSelection,
    runtimeMode: overrides.runtimeMode,
    interactionMode: overrides.interactionMode,
    branch: overrides.branch,
    worktreePath: overrides.worktreePath,
  });
  const projection: OrchestrationV2ThreadProjection = {
    thread: {
      id: shell.id,
      projectId: shell.projectId,
      title: shell.title,
      providerInstanceId: shell.providerInstanceId,
      modelSelection: shell.modelSelection,
      runtimeMode: shell.runtimeMode,
      interactionMode: shell.interactionMode,
      branch: shell.branch,
      worktreePath: shell.worktreePath,
      activeProviderThreadId: shell.activeProviderThreadId,
      lineage: shell.lineage,
      forkedFrom: shell.forkedFrom,
      createdBy: shell.createdBy,
      creationSource: shell.creationSource,
      createdAt: shell.createdAt,
      updatedAt: shell.updatedAt,
      archivedAt: shell.archivedAt,
      deletedAt: shell.deletedAt,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: shell.updatedAt,
  };
  return {
    ...presentThread(overrides.environmentId ?? EnvironmentId.make("environment-test"), projection),
    ...overrides,
  };
}
