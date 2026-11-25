import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertSimpleOutput } from "./codex_output.ts";
import { projectionFor } from "../shared.ts";

export function assertGrokSimpleOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertSimpleOutput(result, transcript);

  const projection = projectionFor(result, transcript.scenario);
  assert.deepEqual(projection.providerThreads[0]?.contextUsage, {
    usedTokens: 22_271,
    maxTokens: 500_000,
  });
}
