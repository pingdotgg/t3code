import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertRunOrdinals,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  MULTI_TURN_SECOND_PROMPT,
  OPENCODE2_SUBAGENT_BACKGROUND_PROMPT,
  projectionFor,
} from "../shared.ts";

export function assertOpenCode2SubagentQueuedTurnOutput(
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
  assertRunOrdinals(projection, [1, 2, 3]);
  assertUserMessagesInclude(projection, [
    OPENCODE2_SUBAGENT_BACKGROUND_PROMPT,
    MULTI_TURN_SECOND_PROMPT,
  ]);
  const subagentItem = projection.turnItems.find((candidate) => candidate.type === "subagent");
  assert.strictEqual(subagentItem?.type, "subagent");
  if (subagentItem?.type !== "subagent") {
    throw new Error("OpenCode 2 background subagent item is missing");
  }
  assert.strictEqual(subagentItem.status, "completed");
  assert.isNotNull(subagentItem.childThreadId);
  const child = result.projections.get(subagentItem.childThreadId!);
  assert.isDefined(child);
  assertAssistantTextIncludes(child!, "CHILD_BACKGROUND_OK");
  assertAssistantTextIncludes(projection, "PARENT_RELEASED");
  assertAssistantTextIncludes(projection, "second fixture turn complete");
  assertAssistantTextIncludes(projection, "CHILD_BACKGROUND_OK");

  const subagentEvents = result.domainEvents.filter((event) => event.type === "subagent.updated");
  const firstTerminal = subagentEvents.findIndex((event) =>
    ["completed", "failed", "cancelled", "interrupted"].includes(event.payload.status),
  );
  assert.isAtLeast(
    firstTerminal,
    1,
    "the native launch acknowledgement must precede terminal child status",
  );
  assert.isTrue(
    subagentEvents
      .slice(0, firstTerminal)
      .every((event) => event.payload.status === "pending" || event.payload.status === "running"),
    "the native launch acknowledgement must not terminalize the linked child",
  );
  assert.strictEqual(subagentEvents[firstTerminal]?.payload.status, "completed");

  const secondRun = projection.runs[1];
  assert.isDefined(secondRun);
  const secondRunEvents = result.domainEvents
    .filter((event) => event.type === "run.created" || event.type === "run.updated")
    .filter((event) => event.runId === secondRun!.id);
  assert.equal(secondRunEvents[0]?.type, "run.created");
  assert.equal(secondRunEvents[0]?.payload.status, "queued");
  assert.equal(
    secondRunEvents.filter((event) => event.payload.status === "running").length,
    1,
    "queued run should promote exactly once after the child settles",
  );

  const continuation = projection.runs[2];
  assert.isDefined(continuation);
  const continuationAssistantItems = projection.turnItems.filter(
    (item) => item.runId === continuation!.id && item.type === "assistant_message",
  );
  assert.lengthOf(continuationAssistantItems, 1);
}
