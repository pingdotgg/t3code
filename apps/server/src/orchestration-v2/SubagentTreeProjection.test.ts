import { describe, expect, it } from "vite-plus/test";
import {
  EventId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ApplicationStoredEvent,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { routeSubagentTreeEvent } from "./SubagentTreeProjection.ts";

const now = DateTime.makeUnsafe("2026-08-18T00:00:00.000Z");

function subagent(input: {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly childThreadId: ThreadId;
}): OrchestrationV2Subagent {
  return {
    id: NodeId.make(input.id),
    threadId: input.threadId,
    runId: null,
    parentNodeId: NodeId.make("parent"),
    origin: "provider_native",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: null,
    childThreadId: input.childThreadId,
    nativeTaskRef: null,
    prompt: "",
    title: input.id,
    model: "gpt-5.6-sol",
    kind: "subagent",
    role: { name: "general-purpose", source: "app_default" },
    status: "running",
    result: null,
    usage: null,
    currentActivationId: null,
    activationCount: 1,
    workflow: null,
    workflowMembership: null,
    recentActivity: [],
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
}

describe("subagent tree projection", () => {
  it("routes nested lifecycle rows to the root fleet and discovers deeper children", () => {
    const rootThreadId = ThreadId.make("root-thread");
    const childThreadId = ThreadId.make("child-thread");
    const grandchildThreadId = ThreadId.make("grandchild-thread");
    const nested = subagent({
      id: "nested-agent",
      threadId: childThreadId,
      childThreadId: grandchildThreadId,
    });

    const stored = {
      sequence: 2,
      commandId: null,
      event: {
        id: EventId.make("nested-update"),
        type: "subagent.updated",
        threadId: childThreadId,
        nodeId: nested.id,
        occurredAt: now,
        payload: nested,
      },
    } satisfies ApplicationStoredEvent;
    const [next, routed] = routeSubagentTreeEvent(
      { rootThreadId, threadIds: new Set([rootThreadId, childThreadId]) },
      stored,
    );

    expect(routed[0]?.event.threadId).toBe(rootThreadId);
    expect(routed[0]?.event.type).toBe("subagent.updated");
    expect(next.threadIds.has(grandchildThreadId)).toBe(true);
  });
});
