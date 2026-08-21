import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertNoExtraAppRunsForProviderChildren,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
  SUBAGENT_CONTINUE_CHILD_PROMPT,
  SUBAGENT_CONTINUE_PARENT_PROMPT,
  SUBAGENT_CONTINUE_PROMPT,
} from "../shared.ts";

export function assertSubagentContinueOutput(
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
  assertNoExtraAppRunsForProviderChildren({ projection, expectedAppRuns: 2 });
  assertUserMessagesInclude(projection, [
    SUBAGENT_CONTINUE_PROMPT,
    SUBAGENT_CONTINUE_PARENT_PROMPT,
  ]);
  assert.lengthOf(projection.subagents, 1);

  const subagent = projection.subagents[0]!;
  assert.equal(subagent.status, "idle");
  // The continuation runs under a second app run. The task identity is
  // reusable, so its row must carry the latest activation's result and be
  // adopted by the run that drove it, not stay frozen on the spawning run.
  assert.equal(subagent.result, "continued subagent response");
  assert.equal(subagent.activationCount, 2);
  // Adoption by the resuming run is what keeps the row routable once the
  // spawning run's ingestion fiber closes; pinned to run 1 it is only visible
  // for as long as that fiber happens to outlive the turn.
  const latestRun = projection.runs.at(-1);
  assert.isDefined(latestRun);
  assert.equal(subagent.runId, latestRun.id);
  assert.isNotNull(subagent.childThreadId);
  if (subagent.childThreadId === null) {
    throw new Error("Continued subagent is missing its child thread");
  }

  const childProjection = result.projections.get(subagent.childThreadId);
  assert.isDefined(childProjection);
  assert.lengthOf(childProjection.runs, 0);
  assert.lengthOf(childProjection.providerTurns, 2);
  assertUserMessagesInclude(childProjection, [subagent.prompt, SUBAGENT_CONTINUE_CHILD_PROMPT]);
  assert.isTrue(
    childProjection.turnItems.some(
      (item) => item.type === "assistant_message" && item.text === "initial subagent response",
    ),
  );
  assert.isTrue(
    childProjection.turnItems.some(
      (item) => item.type === "assistant_message" && item.text === "continued subagent response",
    ),
  );
}
