import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertRunOrdinals,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypeSequence,
  assertUserMessagesInclude,
  assertVisibleTurnItemTypeSequence,
  assertVisibleUserMessagesExclude,
  assertVisibleUserMessagesInclude,
  projectionFor,
  THREAD_ROLLBACK_AFTER_PROMPT,
  THREAD_ROLLBACK_FIRST_PROMPT,
  THREAD_ROLLBACK_SECOND_PROMPT,
} from "../shared.ts";

export function assertClaudeThreadRollbackOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 3,
    runStatuses: ["completed", "rolled_back", "completed"],
  });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertRunOrdinals(projection, [1, 2, 3]);
  assertTurnItemTypeSequence(projection, [
    "user_message",
    "assistant_message",
    "checkpoint",
    "user_message",
    "assistant_message",
    "checkpoint",
    "user_message",
    "assistant_message",
    "checkpoint",
  ]);
  assertVisibleTurnItemTypeSequence(projection, [
    "user_message",
    "assistant_message",
    "checkpoint",
    "user_message",
    "assistant_message",
    "checkpoint",
  ]);
  assertUserMessagesInclude(projection, [
    THREAD_ROLLBACK_FIRST_PROMPT,
    THREAD_ROLLBACK_SECOND_PROMPT,
    THREAD_ROLLBACK_AFTER_PROMPT,
  ]);
  assertVisibleUserMessagesInclude(projection, [
    THREAD_ROLLBACK_FIRST_PROMPT,
    THREAD_ROLLBACK_AFTER_PROMPT,
  ]);
  assertVisibleUserMessagesExclude(projection, [THREAD_ROLLBACK_SECOND_PROMPT]);
  assert.isAtLeast(projection.checkpoints.length, 2);
  assert.isTrue(
    projection.runs.some((run) => run.status === "rolled_back"),
    "rollback must be visible in run state",
  );
  assert.equal(projection.providerThreads[0]?.nativeConversationHeadRef, null);
}
