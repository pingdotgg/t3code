import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertConversationMessageRoles,
  assertRunOrdinals,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";

export function assertQueuedTurnOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertRunOrdinals(projection, [1, 2]);
  assertConversationMessageRoles(projection, ["user", "assistant", "user", "assistant"]);
  assertTurnItemTypes(projection, ["user_message", "assistant_message"]);
  assertUserMessagesInclude(projection, [
    "Respond with exactly: first fixture turn complete",
    "Respond with exactly: second fixture turn complete",
  ]);
  assert.equal(projection.turnItems.filter((item) => item.type === "user_message").length, 2);
  assertAssistantTextIncludes(projection, "first fixture turn complete");
  assertAssistantTextIncludes(projection, "second fixture turn complete");

  const run2Events = result.domainEvents
    .filter((event) => event.type === "run.created" || event.type === "run.updated")
    .filter((event) => event.runId === projection.runs[1]?.id);
  assert.equal(run2Events[0]?.type, "run.created");
  assert.equal(run2Events[0]?.payload.status, "queued");
  assert.isTrue(run2Events.some((event) => event.payload.status === "running"));
}
