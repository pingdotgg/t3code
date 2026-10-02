import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
  SUBAGENT_V2_NESTED_APPROVAL_PROMPT,
} from "../shared.ts";
import { NESTED_SUBAGENT_APPROVAL_PENDING_SHELL_KEY } from "./input.ts";

/**
 * Codex asks for a grandchild's command approval on the grandchild's own
 * native thread and turn. The request is asked on the top-level thread and
 * run instead, under the top-level subagent that leads to the grandchild.
 */
export function assertSubagentV2NestedApprovalOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [SUBAGENT_V2_NESTED_APPROVAL_PROMPT]);
  const run = projection.runs[0]!;

  assert.lengthOf(projection.subagents, 1);
  const child = projection.subagents[0]!;
  assert.equal(child.origin, "provider_native");
  assert.equal(child.status, "completed");
  assert.equal(child.result, "Written.");
  const childProjection = result.projections.get(child.childThreadId!);
  assert.isDefined(childProjection);
  assert.lengthOf(childProjection.subagents, 1);
  const grandchild = childProjection.subagents[0]!;
  assert.equal(grandchild.status, "completed");
  assert.equal(grandchild.result, "Written.");
  const grandchildProjection = result.projections.get(grandchild.childThreadId!);
  assert.isDefined(grandchildProjection);
  assert.equal(grandchildProjection.thread.lineage.parentThreadId, childProjection.thread.id);
  assert.equal(grandchildProjection.thread.lineage.rootThreadId, projection.thread.id);

  const requests = projection.runtimeRequests;
  assert.lengthOf(requests, 1);
  const request = requests[0]!;
  assert.equal(request.kind, "command");
  assert.equal(request.status, "resolved");
  assert.equal(request.decision, "accept");
  assert.equal(
    projection.providerTurns.find((turn) => turn.id === request.providerTurnId)?.runAttemptId,
    run.activeAttemptId,
    "the request belongs to the top-level provider turn",
  );

  const node = projection.nodes.find((candidate) => candidate.id === request.nodeId);
  assert.isDefined(node);
  assert.equal(node.kind, "approval_request");
  assert.equal(node.threadId, projection.thread.id);
  assert.equal(node.runId, run.id);
  assert.equal(
    node.parentNodeId,
    child.id,
    "the approval hangs off the top-level subagent, the one node on this thread that leads to the grandchild",
  );
  assert.equal(node.status, "completed");

  const approvalItems = projection.turnItems.filter((item) => item.type === "approval_request");
  assert.lengthOf(approvalItems, 1);
  const approval = approvalItems[0]!;
  assert.equal(approval.runId, run.id);
  assert.equal(approval.status, "completed");
  if (approval.type !== "approval_request") throw new Error("expected an approval item");
  assert.equal(approval.requestId, request.id);
  assert.include(approval.prompt ?? "", "nested-approval.txt");

  // While Codex waited, only the top-level thread reported the approval.
  const pendingShell = result.capturedShellSnapshots.get(
    NESTED_SUBAGENT_APPROVAL_PENDING_SHELL_KEY,
  );
  assert.isDefined(pendingShell);
  const pendingThreads = pendingShell.threads;
  const rootShell = pendingThreads.find((thread) => thread.id === projection.thread.id);
  assert.equal(rootShell?.pendingRuntimeRequest?.id, request.id);
  for (const nested of [childProjection, grandchildProjection]) {
    const nestedShell = pendingThreads.find((thread) => thread.id === nested.thread.id);
    assert.isDefined(nestedShell, `${nested.thread.id} exists while the approval is pending`);
    assert.isNull(nestedShell.pendingRuntimeRequest);
  }

  // Neither native child thread holds a request; the grandchild ran the command.
  for (const nested of [childProjection, grandchildProjection]) {
    assert.lengthOf(nested.runtimeRequests, 0);
    assert.isFalse(nested.turnItems.some((item) => item.type === "approval_request"));
  }
  const command = grandchildProjection.turnItems.find((item) => item.type === "command_execution");
  assert.equal(command?.status, "completed");
  assert.isTrue(
    grandchildProjection.turnItems.some(
      (item) => item.type === "assistant_message" && item.text.includes("Written."),
    ),
  );
}
