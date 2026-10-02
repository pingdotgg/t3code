import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertVisibleUserMessagesExclude,
  assertVisibleUserMessagesInclude,
  OPENCODE2_REVERT_FIRST_PROMPT,
  OPENCODE2_REVERT_SECOND_PROMPT,
  projectionFor,
} from "../shared.ts";

/**
 * The rollback stages a revert before the second turn's user message and
 * commits it, so OpenCode's history ends with the first turn.
 */
export function assertOpenCode2RevertOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "rolled_back"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleUserMessagesInclude(projection, [OPENCODE2_REVERT_FIRST_PROMPT]);
  assertVisibleUserMessagesExclude(projection, [OPENCODE2_REVERT_SECOND_PROMPT]);
  // The provider thread's head is the kept turn's prompt, OpenCode's last user message.
  const kept = projection.providerTurns.find((turn) => turn.ordinal === 1);
  assert.equal(
    projection.providerThreads[0]?.nativeConversationHeadRef?.nativeId,
    kept?.nativeTurnRef?.nativeId,
  );
}
