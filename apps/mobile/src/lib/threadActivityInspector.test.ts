import { EMPTY_V2_ITEM_SUPPORT } from "@t3tools/client-runtime/state/item-support";
import {
  CheckpointId,
  CheckpointScopeId,
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadFeedActivity } from "./threadActivity";
import { buildThreadActivityInspector } from "./threadActivityInspector";

const threadId = ThreadId.make("thread-1");
const sourceThreadId = ThreadId.make("thread-source");
const runId = RunId.make("run-1");
const nodeId = NodeId.make("node-1");
const startedAt = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const completedAt = DateTime.makeUnsafe("2026-06-20T00:00:02.000Z");

function itemBase(id: string) {
  return {
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed" as const,
    title: null,
    startedAt,
    completedAt,
    updatedAt: completedAt,
  };
}

function activityFor(item: OrchestrationV2TurnItem): Pick<ThreadFeedActivity, "projectedItem"> {
  const row: OrchestrationV2ProjectedTurnItem = {
    position: 0,
    visibility: "inherited",
    sourceThreadId,
    sourceItemId: item.id,
    item,
  };
  return { projectedItem: row };
}

describe("buildThreadActivityInspector", () => {
  it("enables rollback only for the matching ready checkpoint", () => {
    const checkpointId = CheckpointId.make("checkpoint-1");
    const scopeId = CheckpointScopeId.make("scope-1");
    const item: OrchestrationV2TurnItem = {
      ...itemBase("checkpoint"),
      type: "checkpoint",
      checkpointId,
      scopeId,
      files: [{ path: "src/main.ts", kind: "modified", additions: 2, deletions: 1 }],
    };
    const checkpoint = { id: checkpointId, scopeId, status: "ready" } as never;
    const model = buildThreadActivityInspector(
      activityFor(item),
      {
        ...EMPTY_V2_ITEM_SUPPORT,
        item,
        checkpoint,
      },
      sourceThreadId,
    );

    expect(model.canRollback).toBe(true);
    expect(model.rollbackTarget).toEqual({
      threadId: sourceThreadId,
      checkpointId,
      scopeId,
    });

    const inheritedModel = buildThreadActivityInspector(
      activityFor(item),
      {
        ...EMPTY_V2_ITEM_SUPPORT,
        item,
        checkpoint,
      },
      ThreadId.make("child-thread"),
    );
    expect(inheritedModel.canRollback).toBe(false);
    expect(inheritedModel.rollbackTarget).toBeNull();
  });
});
