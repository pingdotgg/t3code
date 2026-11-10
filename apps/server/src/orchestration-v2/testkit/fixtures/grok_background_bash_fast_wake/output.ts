import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertGrokBackgroundBashOutput } from "../grok_background_bash/output.ts";

export function assertGrokBackgroundBashFastWakeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertGrokBackgroundBashOutput(result, transcript, "Run tock loop in background");
}
