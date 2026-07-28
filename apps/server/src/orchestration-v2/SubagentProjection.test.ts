import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { makeSubagentChildThread } from "./SubagentProjection.ts";

const parentThreadId = ThreadId.make("thread:subagent-snoozed-parent");
const childThreadId = ThreadId.make("thread:subagent-awake-child");
const parentProviderInstanceId = ProviderInstanceId.make("codex");
const childProviderInstanceId = ProviderInstanceId.make("claude");
const parentModelSelection = {
  instanceId: parentProviderInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;
const childModelSelection = {
  instanceId: childProviderInstanceId,
  model: "claude-opus-4-1",
} satisfies ModelSelection;
const parentCreatedAt = DateTime.makeUnsafe("2026-07-24T09:00:00.000Z");
const snoozedAt = DateTime.makeUnsafe("2026-07-24T09:05:00.000Z");
const snoozedUntil = DateTime.makeUnsafe("2026-07-25T09:00:00.000Z");
const childCreatedAt = DateTime.makeUnsafe("2026-07-24T09:10:00.000Z");

function makeParentThread(): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: parentThreadId,
    projectId: ProjectId.make("project:subagent-snooze"),
    title: "Snoozed parent",
    providerInstanceId: parentProviderInstanceId,
    modelSelection: parentModelSelection,
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: "feature/source",
    worktreePath: "/tmp/source-worktree",
    activeProviderThreadId: ProviderThreadId.make("provider-thread:subagent-snoozed-parent"),
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: parentThreadId,
    },
    forkedFrom: null,
    createdAt: parentCreatedAt,
    updatedAt: snoozedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil,
    snoozedAt,
    deletedAt: null,
    historyOrigin: "v1_import",
  };
}

it("keeps a subagent child awake when its parent thread is snoozed", () => {
  const parentThread = makeParentThread();
  const childProviderThreadId = ProviderThreadId.make("provider-thread:subagent-awake-child");
  const parentNodeId = NodeId.make("node:subagent-parent");
  const childThread = makeSubagentChildThread({
    parentThread,
    childThreadId,
    parentNodeId,
    activeProviderThreadId: childProviderThreadId,
    providerInstanceId: childProviderInstanceId,
    modelSelection: childModelSelection,
    title: "Awake child",
    now: childCreatedAt,
    createdBy: "agent",
    creationSource: "provider",
  });

  assert.isNull(childThread.snoozedUntil);
  assert.isNull(childThread.snoozedAt);
  assert.equal(childThread.projectId, parentThread.projectId);
  assert.equal(childThread.runtimeMode, parentThread.runtimeMode);
  assert.equal(childThread.interactionMode, parentThread.interactionMode);
  assert.equal(childThread.branch, parentThread.branch);
  assert.equal(childThread.worktreePath, parentThread.worktreePath);
  assert.equal(childThread.providerInstanceId, childProviderInstanceId);
  assert.deepEqual(childThread.modelSelection, childModelSelection);
  assert.equal(childThread.activeProviderThreadId, childProviderThreadId);
  assert.isUndefined(childThread.historyOrigin);
  assert.deepEqual(childThread.lineage, {
    parentThreadId,
    relationshipToParent: "subagent",
    rootThreadId: parentThreadId,
  });
  assert.deepEqual(childThread.forkedFrom, {
    type: "node",
    nodeId: parentNodeId,
  });
});
