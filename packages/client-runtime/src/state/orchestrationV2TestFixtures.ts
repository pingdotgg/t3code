import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export const v2Now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
export const v2ProjectId = ProjectId.make("project-v2");
export const v2ThreadId = ThreadId.make("thread-v2");
export const v2ProviderInstanceId = ProviderInstanceId.make("codex");

export const v2Project: OrchestrationProjectShell = {
  id: v2ProjectId,
  title: "Project",
  workspaceRoot: "/workspace/project",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
};

export const v2ThreadShell: OrchestrationV2ThreadShell = {
  id: v2ThreadId,
  projectId: v2ProjectId,
  title: "Thread",
  providerInstanceId: v2ProviderInstanceId,
  modelSelection: { instanceId: v2ProviderInstanceId, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: v2ThreadId, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: v2Now,
  updatedAt: v2Now,
  archivedAt: null,
  deletedAt: null,
};

export const v2Projection: OrchestrationV2ThreadProjection = {
  thread: {
    id: v2ThreadShell.id,
    projectId: v2ThreadShell.projectId,
    title: v2ThreadShell.title,
    providerInstanceId: v2ThreadShell.providerInstanceId,
    modelSelection: v2ThreadShell.modelSelection,
    runtimeMode: v2ThreadShell.runtimeMode,
    interactionMode: v2ThreadShell.interactionMode,
    branch: v2ThreadShell.branch,
    worktreePath: v2ThreadShell.worktreePath,
    activeProviderThreadId: v2ThreadShell.activeProviderThreadId,
    lineage: v2ThreadShell.lineage,
    forkedFrom: v2ThreadShell.forkedFrom,
    createdBy: v2ThreadShell.createdBy,
    creationSource: v2ThreadShell.creationSource,
    createdAt: v2Now,
    updatedAt: v2Now,
    archivedAt: null,
    deletedAt: null,
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
  updatedAt: v2Now,
};

export const v2ShellSnapshot: OrchestrationV2ShellSnapshot = {
  schemaVersion: 1,
  snapshotSequence: 0,
  projects: [v2Project],
  threads: [v2ThreadShell],
  archivedThreads: [],
};
