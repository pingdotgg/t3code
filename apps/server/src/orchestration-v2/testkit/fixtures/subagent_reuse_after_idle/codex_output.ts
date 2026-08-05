import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
  SUBAGENT_REUSE_AFTER_IDLE_PROMPT,
  SUBAGENT_REUSE_AFTER_IDLE_RESUME_PROMPT,
} from "../shared.ts";

export function assertSubagentReuseAfterIdleOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [
    SUBAGENT_REUSE_AFTER_IDLE_PROMPT,
    SUBAGENT_REUSE_AFTER_IDLE_RESUME_PROMPT,
  ]);

  // A duplicate here means the reaped registry was never rehydrated from the
  // projection, so the returning agent thread read as a stranger.
  assert.lengthOf(
    projection.subagents,
    1,
    "the session reap caused the reused subagent to be registered as a new identity",
  );
  const subagent = projection.subagents[0]!;

  assert.isAtLeast(
    subagent.activationCount,
    2,
    "the subagent was not re-activated after the session was reaped",
  );
  const activations = projection.subagentActivations.filter(
    (activation) => activation.subagentId === subagent.id,
  );
  assert.isAtLeast(activations.length, 2, "each activation must be recorded separately");

  const latestRun = projection.runs.at(-1);
  assert.isDefined(latestRun);
  assert.equal(
    subagent.runId,
    latestRun.id,
    "the re-activated subagent was not adopted by the run driving it",
  );

  assert.isNotNull(subagent.childThreadId);
  if (subagent.childThreadId === null) {
    throw new Error("Re-activated subagent is missing its child thread");
  }
  const childProjection = result.projections.get(subagent.childThreadId);
  assert.isDefined(childProjection);
  // One child thread carrying both turns proves the original agent thread was
  // resumed rather than a second one created alongside it.
  assert.isAtLeast(childProjection.providerTurns.length, 2);
}
