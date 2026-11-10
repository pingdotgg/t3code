import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertBaseProjection, projectionFor } from "../shared.ts";

export function assertOpenCode2MissingStepUsageOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const [providerTurn] = projectionFor(result, transcript.scenario).providerTurns;
  assert.equal(providerTurn?.status, "completed");
  // The measured step survives; the step without a report keeps the turn total partial.
  assert.deepInclude(providerTurn?.turnTokenUsage, {
    usageStatus: "partial",
    inputTokens: 8701 + 489,
    outputTokens: 113 + 147,
    reasoningTokens: 147,
    models: ["opencode/space-bunny-free"],
  });
}
