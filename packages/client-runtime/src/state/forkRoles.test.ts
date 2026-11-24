import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";

const now = DateTime.makeUnsafe("2026-11-23T00:00:00.000Z");
const later = DateTime.makeUnsafe("2026-11-23T01:00:00.000Z");
const threadId = ThreadId.make("thread-role");
const projection = {
  thread: {
    id: threadId,
    projectId: ProjectId.make("project-role"),
    title: "Needs you",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
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
} as OrchestrationV2ThreadProjection;

const roleSet = (roleId: string | null) =>
  ({
    id: `event-role-${roleId}`,
    type: "thread.role-set",
    threadId,
    occurredAt: later,
    payload: { ...projection.thread, roleId, updatedAt: later },
  }) as OrchestrationV2DomainEvent;

describe("thread.role-set", () => {
  it("sets and clears the role without counting as activity", () => {
    const set = applyOrchestrationV2ProjectionEvent(projection, roleSet("coordinator"));
    expect(set?.thread.roleId).toBe("coordinator");
    expect(set?.updatedAt).toEqual(now);
    const cleared = applyOrchestrationV2ProjectionEvent(set!, roleSet(null));
    expect(cleared?.thread.roleId).toBeNull();
  });
});
