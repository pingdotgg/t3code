import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertSemanticProjectionIntegrity, projectionFor } from "../shared.ts";
import { CLAUDE_COMPACT_FIRST_PROMPT } from "../claude_compact_after_peer_turn/input.ts";
import { claudeCompactRuns } from "../claude_compact_after_peer_turn/output.ts";

// A CLI before 2.1.252 neither echoes prompt uuids nor acknowledges them, so
// nothing says the peer turn is not `/compact`'s. Its result settles the
// `/compact` run, as it always has: the run must not wait for a result that
// may never come.
export function assertClaudeCompactAfterPeerTurnNoEchoOutput(
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
      replies: ["PEER_ACK"],
      compactions: [],
    },
  ]);
}
