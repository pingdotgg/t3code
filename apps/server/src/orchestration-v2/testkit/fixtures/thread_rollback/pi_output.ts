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

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function outboundOfType(transcript: ProviderReplayTranscript, type: string) {
  return transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" && field(entry.frame, "type") === type ? [entry.frame] : [],
  );
}

/**
 * Pi rolls back by re-rooting its session tree with `fork(entryId)` at the
 * first user entry of the earliest discarded turn. That id is the discarded
 * turn's strong native ref, captured from `get_entries` when the turn settled.
 * The fork writes a new session file, and the next turn resumes that file.
 */
export function assertPiThreadRollbackOutput(
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
  const turn = ["user_message", "reasoning", "assistant_message", "checkpoint"] as const;
  assertTurnItemTypeSequence(projection, [...turn, ...turn, ...turn]);
  assertVisibleTurnItemTypeSequence(projection, [...turn, ...turn]);
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

  const forks = outboundOfType(transcript, "fork");
  assert.lengthOf(forks, 1, "rollback must fork the Pi session tree exactly once");
  const discardedTurn = projection.providerTurns.find((providerTurn) => providerTurn.ordinal === 2);
  assert.equal(discardedTurn?.nativeTurnRef?.strength, "strong");
  assert.equal(field(forks[0], "entryId"), discardedTurn?.nativeTurnRef?.nativeId);

  // The fork moved the thread to a new session file; the post-rollback turn
  // resumes that file, never the pre-rollback one.
  const [providerThread] = projection.providerThreads;
  assert.lengthOf(projection.providerThreads, 1);
  assert.equal(providerThread?.nativeThreadRef?.nativeId, "/pi-sessions/session-2.jsonl");
  assert.deepEqual(
    outboundOfType(transcript, "switch_session").map((frame) => field(frame, "sessionPath")),
    ["/pi-sessions/session-2.jsonl"],
  );

  // The model has only the surviving branch: the discarded exchange is gone.
  const finalAnswer = projection.turnItems.findLast((item) => item.type === "assistant_message");
  assert.include(finalAnswer?.text, "rollback fixture first turn complete");
  assert.notInclude(finalAnswer?.text, "second turn");
}
