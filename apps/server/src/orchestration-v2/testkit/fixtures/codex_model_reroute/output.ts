import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertBaseProjection, projectionFor } from "../shared.ts";

export function assertCodexModelRerouteOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  const [first, second] = projectionFor(result, transcript.scenario).providerTurns;
  // The reroute names the first turn only; without new settings the second turn's model is unknown.
  assert.deepEqual(first?.turnTokenUsage?.models, ["gpt-6-astra"]);
  assert.notProperty(second?.turnTokenUsage, "models");
}
