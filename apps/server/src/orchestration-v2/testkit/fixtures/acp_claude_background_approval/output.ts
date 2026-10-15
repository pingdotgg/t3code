import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

// The subagent's approval lands in a provider continuation run (run 2), which
// completes once the approval is answered. The subagent then finishes in its
// child thread, and Claude's own follow-up is run 3.
export function assertAcpClaudeBackgroundApprovalOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 3,
    runStatuses: ["completed", "completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  const [rootRun, approvalRun, followUpRun] = projection.runs;

  for (const run of [approvalRun, followUpRun]) {
    const message = projection.messages.find((candidate) => candidate.id === run?.userMessageId);
    assert.equal(`${message?.createdBy}:${message?.creationSource}`, "agent:provider");
  }
  assert.deepEqual(
    projection.turnItems.flatMap((item) =>
      item.type === "approval_request" ? [`${item.runId === approvalRun?.id}:${item.status}`] : [],
    ),
    ["true:completed"],
  );
  const rootCompletedAt = result.domainEvents.findIndex(
    (event) =>
      event.type === "run.updated" &&
      event.payload.id === rootRun?.id &&
      event.payload.status === "completed",
  );
  const approvalStartedAt = result.domainEvents.findIndex(
    (event) => event.type === "run.updated" && event.payload.id === approvalRun?.id,
  );
  assert.isAbove(approvalStartedAt, rootCompletedAt);

  assert.deepEqual(
    projection.subagents.map((subagent) => `${subagent.runId === rootRun?.id}:${subagent.status}`),
    ["true:completed"],
  );
  const childThreadId = projection.subagents[0]?.childThreadId;
  if (childThreadId == null) throw new Error("The subagent is missing its child thread.");
  assert.deepEqual(
    result.projections
      .get(childThreadId)
      ?.turnItems.flatMap((item) =>
        item.type === "assistant_message"
          ? [`${item.type}:${item.text}`]
          : item.type === "dynamic_tool"
            ? [`${item.type}:${item.status}`]
            : [],
      ),
    ["dynamic_tool:completed", "assistant_message:SUBAGENT_DONE"],
  );
}
