import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { ChatMessage, Thread } from "./types";

const DEFAULT_TIMESTAMP = "2026-01-01T00:00:00.000Z";

export type ThreadFixtureOverrides = Partial<Thread> & {
  /** Test-only fallback data for the generic thread-sort contract. */
  readonly messages?: ReadonlyArray<ChatMessage>;
  /** Accepted while older unit cases are migrated; never consumed by production code. */
  readonly proposedPlans?: ReadonlyArray<unknown>;
};

export function makeThreadProjectionFixture(): OrchestrationV2ThreadProjection {
  const now = DateTime.makeUnsafe(DEFAULT_TIMESTAMP);
  const id = ThreadId.make("thread-test");
  const providerInstanceId = ProviderInstanceId.make("codex");
  return {
    thread: {
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
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
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
    updatedAt: now,
  };
}

/** Creates a structurally complete V2 shell for UI unit tests. */
export function makeThreadFixture(overrides: ThreadFixtureOverrides = {}): Thread {
  const environmentId = overrides.environmentId ?? EnvironmentId.make("environment-test");
  const id = overrides.id ?? ThreadId.make("thread-test");
  const projectId = overrides.projectId ?? ProjectId.make("project-test");
  const providerInstanceId =
    overrides.providerInstanceId ??
    overrides.modelSelection?.instanceId ??
    ProviderInstanceId.make("codex");
  const modelSelection = overrides.modelSelection ?? {
    instanceId: providerInstanceId,
    model: "gpt-5.4",
  };
  const createdAt = DateTime.makeUnsafe(DEFAULT_TIMESTAMP);
  const updatedAt = DateTime.makeUnsafe(DEFAULT_TIMESTAMP);
  const archivedAt =
    overrides.archivedAt === null || overrides.archivedAt === undefined
      ? null
      : DateTime.makeUnsafe(overrides.archivedAt);
  const deletedAt =
    overrides.deletedAt === null || overrides.deletedAt === undefined
      ? null
      : DateTime.makeUnsafe(overrides.deletedAt);
  const shell = presentThreadShell(environmentId, {
    id,
    projectId,
    title: overrides.title ?? "Thread",
    providerInstanceId,
    modelSelection,
    runtimeMode: overrides.runtimeMode ?? "full-access",
    interactionMode: overrides.interactionMode ?? "default",
    branch: overrides.branch ?? null,
    worktreePath: overrides.worktreePath ?? null,
    activeProviderThreadId: overrides.activeProviderThreadId ?? null,
    lineage: overrides.lineage ?? {
      rootThreadId: id,
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: overrides.forkedFrom ?? null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: overrides.latestRun?.runId ?? null,
    activeRunId: overrides.runtime?.activeRunId ?? null,
    status: overrides.runtime?.status ?? "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt:
      overrides.latestUserMessageAt === null || overrides.latestUserMessageAt === undefined
        ? null
        : DateTime.makeUnsafe(overrides.latestUserMessageAt),
    hasActionableProposedPlan: overrides.hasActionableProposedPlan ?? false,
    itemCount: overrides.itemCount ?? 0,
    visibleItemCount: overrides.visibleItemCount ?? 0,
    createdAt,
    updatedAt,
    archivedAt,
    deletedAt,
  });

  return { ...shell, ...overrides };
}
