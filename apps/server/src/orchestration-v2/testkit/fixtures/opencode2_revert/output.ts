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
  assertVisibleUserMessagesInclude(projection, [OPENCODE2_REVERT_FIRST_PROMPT, "From the GUI"]);
  assertVisibleUserMessagesExclude(projection, [OPENCODE2_REVERT_SECOND_PROMPT]);
  const visibleReplies = projection.visibleTurnItems.flatMap(({ item }) =>
    item.type === "assistant_message" ? [item.text] : [],
  );
  assert.deepEqual(visibleReplies, ["DONE", "GUI_REPLY"]);
  assert.equal(
    projection.providerThreads[0]?.nativeConversationHeadRef?.nativeId,
    "msg_external_prompt",
  );
}
