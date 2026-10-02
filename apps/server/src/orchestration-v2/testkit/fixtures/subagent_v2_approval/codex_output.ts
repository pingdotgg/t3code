import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
  SUBAGENT_V2_APPROVAL_PROMPT,
} from "../shared.ts";
import { SUBAGENT_APPROVAL_PENDING_SHELL_KEY } from "./input.ts";

/**
 * A multi-agent v2 child inherits the root's approval policy, and Codex asks
 * for its command approval on the child's own native thread and turn. The
 * request is asked on the parent thread and run instead, under the subagent,
 * because native subagent threads are hidden from the sidebar.
 */
export function assertSubagentV2ApprovalOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [SUBAGENT_V2_APPROVAL_PROMPT]);
  const run = projection.runs[0]!;

  assert.lengthOf(projection.subagents, 1);
  const subagent = projection.subagents[0]!;
  assert.equal(subagent.origin, "provider_native");
  assert.equal(subagent.status, "completed");
  assert.equal(subagent.result, "Written.");
  assert.isNotNull(subagent.childThreadId);

  const requests = projection.runtimeRequests;
  assert.lengthOf(requests, 1);
  const request = requests[0]!;
  assert.equal(request.kind, "command");
  assert.equal(request.status, "resolved");
  assert.equal(request.decision, "accept");
  assert.equal(
    projection.providerTurns.find((turn) => turn.id === request.providerTurnId)?.runAttemptId,
    run.activeAttemptId,
    "the request belongs to the parent's root provider turn",
  );

  const node = projection.nodes.find((candidate) => candidate.id === request.nodeId);
  assert.isDefined(node);
  assert.equal(node.kind, "approval_request");
  assert.equal(node.runId, run.id);
  assert.equal(node.parentNodeId, subagent.id, "the approval hangs off the subagent that asked");
  assert.equal(node.status, "completed");

  const approvalItems = projection.turnItems.filter((item) => item.type === "approval_request");
  assert.lengthOf(approvalItems, 1);
  const approval = approvalItems[0]!;
  assert.equal(approval.runId, run.id);
  assert.equal(approval.status, "completed");
  if (approval.type !== "approval_request") throw new Error("expected an approval item");
  assert.equal(approval.requestId, request.id);
  assert.include(approval.prompt ?? "", "subagent-approval.txt");

  // While Codex waited, the parent reported the approval and the child did not.
  const pendingShell = result.capturedShellSnapshots.get(SUBAGENT_APPROVAL_PENDING_SHELL_KEY);
  assert.isDefined(pendingShell);
  const parentShell = pendingShell.threads.find((thread) => thread.id === projection.thread.id);
  assert.equal(parentShell?.pendingRuntimeRequest?.id, request.id);
  const childShell = pendingShell.threads.find((thread) => thread.id === subagent.childThreadId);
  assert.isDefined(childShell, "the child thread exists while its approval is pending");
  assert.isNull(childShell.pendingRuntimeRequest);

  // The child keeps its own work and answer, and never holds a request.
  const child = result.projections.get(subagent.childThreadId!);
  assert.isDefined(child);
  assert.lengthOf(child.runtimeRequests, 0);
  assert.isFalse(child.turnItems.some((item) => item.type === "approval_request"));
  const command = child.turnItems.find((item) => item.type === "command_execution");
  assert.equal(command?.status, "completed");
  assert.isTrue(
    child.turnItems.some(
      (item) => item.type === "assistant_message" && item.text.includes("Written."),
    ),
  );
}
