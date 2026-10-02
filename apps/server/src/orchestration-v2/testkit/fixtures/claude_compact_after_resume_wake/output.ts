import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertSemanticProjectionIntegrity, projectionFor } from "../shared.ts";
import { CLAUDE_COMPACT_FIRST_PROMPT } from "../claude_compact_after_peer_turn/input.ts";
import { claudeCompactRuns } from "../claude_compact_after_peer_turn/output.ts";

// The resumed process has not echoed yet, but it acknowledged the `/compact`
// prompt's uuid, so the wake's unechoed result is another turn's: it must not
// end `/compact` before its compaction. The wake reply streamed before the
// echo could place it, so it stays on the `/compact` run, as on a CLI that
// echoes only on the result.
export function assertClaudeCompactAfterResumeWakeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assert.deepEqual(claudeCompactRuns(projection), [
    {
      text: CLAUDE_COMPACT_FIRST_PROMPT,
      fromUser: true,
      status: "completed",
      replies: ["compact probe first turn"],
      compactions: [],
    },
    {
      text: "/compact",
      fromUser: true,
      status: "completed",
      replies: ["A_REPORTED"],
      compactions: [[27445, 1192]],
    },
  ]);
}
