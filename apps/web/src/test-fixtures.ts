import { presentThread } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { Thread } from "./types";

const DEFAULT_TIMESTAMP = "2026-01-01T00:00:00.000Z";

/** Creates a structurally complete V2 thread for UI unit tests. */
export function makeThreadFixture(overrides: Partial<Thread> = {}): Thread {
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
  // Presentation-level overrides are applied after projection. Keep the source
  // projection valid so tests can deliberately exercise malformed persisted
  // timestamps without failing inside Effect's DateTime constructor first.
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
  const projection: OrchestrationV2ThreadProjection = {
    thread: {
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
      createdAt,
      updatedAt,
      archivedAt,
      deletedAt,
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
    updatedAt,
  };

  return {
    ...presentThread(environmentId, projection),
    ...overrides,
  };
}
