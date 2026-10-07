import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertPiSettledTokenUsage } from "../simple/pi_output.ts";
import { assertMultiTurnOutput } from "./codex_output.ts";

/**
 * The second turn's settled usage is the session total from
 * `get_session_stats`, which differs from its last streamed message usage.
 */
export function assertPiMultiTurnOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertMultiTurnOutput(result, transcript);
  assertPiSettledTokenUsage(result, transcript);
}
