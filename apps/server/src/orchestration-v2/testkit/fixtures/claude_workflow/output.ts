import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { CLAUDE_WORKFLOW_PROMPT } from "./input.ts";

export function assertClaudeWorkflowOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [CLAUDE_WORKFLOW_PROMPT]);

  const coordinator = projection.subagents.find((subagent) => subagent.kind === "workflow");
  assert.isDefined(coordinator, "the workflow must reach the projection as a coordinator");
  assert.deepEqual(coordinator?.role, { name: "workflow-coordinator", source: "app_default" });
  // Phases arrive on progress snapshots; run handles arrive on the launch
  // ACK; the name arrives on task_started. All three must merge rather than
  // the later write clobbering the earlier ones. The fixture's hostile
  // `javascript:` sessionUrl must be dropped by the scheme filter, not
  // carried into the projection.
  assert.deepEqual(coordinator?.workflow, {
    phases: [
      { index: 0, title: "Research" },
      { index: 1, title: "Implement" },
    ],
    name: "research-implement",
    runId: "wf_run_fixture01",
    scriptPath: "/tmp/claude-replay-claude_workflow/.claude/workflows/research-implement.mjs",
    transcriptDir:
      "/tmp/claude-replay-claude_workflow/.claude/projects/-tmp-claude-replay/wf_run_fixture01",
  });
  // The Workflow tool_use projects as the coordinator row only; registering
  // it as a tool call too would render the run twice in the timeline.
  assert.lengthOf(
    projection.turnItems.filter(
      (item) => item.type === "dynamic_tool" && item.toolName === "Workflow",
    ),
    0,
    "the Workflow tool_use must not double-render as a tool call",
  );

  const members = projection.subagents
    .filter((subagent) => subagent.kind === "workflow_agent")
    .toSorted(
      (left, right) =>
        (left.workflowMembership?.agentIndex ?? 0) - (right.workflowMembership?.agentIndex ?? 0),
    );
  assert.lengthOf(members, 2, "both workflow members must reach the projection");
  assert.deepEqual(
    members.map((member) => [
      member.title,
      member.status,
      member.workflowMembership?.phaseIndex,
      member.model,
      member.usage?.totalTokens,
    ]),
    [
      ["Researcher", "completed", 0, "claude-sonnet-4-6", 400],
      ["Implementer", "completed", 1, "claude-opus-4-1", 600],
    ],
  );
  // Membership must point at the coordinator that actually reached the
  // projection, not at an id the adapter invented independently.
  assert.deepEqual(
    [...new Set(members.map((member) => member.workflowMembership?.workflowSubagentId))],
    [coordinator?.id],
  );
  const coordinatorNode = projection.nodes.find((node) => node.id === coordinator?.id);
  assert.isDefined(coordinatorNode);
  for (const member of members) {
    const memberNode = projection.nodes.find((node) => node.id === member.id);
    assert.isDefined(memberNode);
    assert.equal(memberNode?.parentNodeId, coordinator?.id);
    assert.equal(
      memberNode?.rootNodeId,
      coordinatorNode?.rootNodeId,
      "workflow members must remain attached to the run root",
    );
  }

  const implementer = members.find((member) => member.title === "Implementer");
  assert.isDefined(implementer);
  assert.equal(implementer?.activationCount, 2);
  assert.equal(implementer?.workflowMembership?.attempt, 2);
  const implementerActivations = projection.subagentActivations
    .filter((activation) => activation.subagentId === implementer?.id)
    .toSorted((left, right) => left.ordinal - right.ordinal);
  assert.deepEqual(
    implementerActivations.map((activation) => [
      activation.ordinal,
      activation.status,
      activation.usage?.totalTokens,
      activation.completedAt !== null,
    ]),
    [
      [1, "failed", 500, true],
      [2, "completed", 100, true],
    ],
    "a workflow retry must settle the prior activation before opening the next",
  );

  // The panel groups by these three fields, so pin the values it reads rather
  // than only the ones the coordinator carries. The derivation itself is
  // covered in client-runtime; the schema is what joins the two sides, so what
  // matters here is that the server emits a shape that groups cleanly:
  // every member claims a declared phase, and no member is left ungrouped.
  const declaredPhases = new Set((coordinator?.workflow?.phases ?? []).map((phase) => phase.index));
  assert.deepEqual(
    members.map((member) => declaredPhases.has(member.workflowMembership?.phaseIndex ?? -1)),
    [true, true],
  );
  assert.lengthOf(
    projection.subagents.filter(
      (subagent) => subagent.kind === "workflow_agent" && subagent.workflowMembership === null,
    ),
    0,
    "a member without membership would render outside its workflow",
  );
  const waitingProgressItem = result.domainEvents.find(
    (event) =>
      event.type === "turn-item.updated" &&
      event.payload.type === "reasoning" &&
      event.payload.text === "Read" &&
      event.payload.status === "waiting",
  );
  assert.isDefined(waitingProgressItem);
  if (waitingProgressItem?.type === "turn-item.updated") {
    assert.isNull(waitingProgressItem.payload.completedAt);
    assert.isTrue(
      waitingProgressItem.payload.type === "reasoning" && waitingProgressItem.payload.streaming,
    );
  }
  // The coordinator's usage already covers its members, so the panel subtracts
  // theirs from it. That only stays non-negative if the provider's totals are
  // carried through unmodified.
  const memberTotal = members.reduce(
    (total, member) => total + (member.usage?.totalTokens ?? 0),
    0,
  );
  assert.isAtLeast(coordinator?.usage?.totalTokens ?? 0, memberTotal);

  const assistantTexts = projection.turnItems.flatMap((item) =>
    item.type === "assistant_message" ? [item.text] : [],
  );
  assert.deepEqual(assistantTexts, [
    "Starting the two-phase workflow.",
    "claude workflow fixture complete",
  ]);
}
