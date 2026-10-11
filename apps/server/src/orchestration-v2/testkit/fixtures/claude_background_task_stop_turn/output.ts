import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { CLAUDE_BACKGROUND_TASK_STOP_TURN_PROMPT } from "./input.ts";

// A turn-scoped Stop interrupts the turn without closing the CLI process, so
// the background command it started keeps running: it stays on the roster
// past the interrupt, and its completion wakes one continuation run.
export function assertClaudeBackgroundTaskStopTurnOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["interrupted", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [CLAUDE_BACKGROUND_TASK_STOP_TURN_PROMPT]);

  const [stoppedRun, wakeRun] = projection.runs;
  const interruptedIndex = result.domainEvents.findIndex(
    (event) =>
      event.type === "run.updated" &&
      event.payload.id === stoppedRun?.id &&
      event.payload.status === "interrupted",
  );
  assert.isAtLeast(interruptedIndex, 0);
  const rosterAtStop = result.domainEvents
    .slice(0, interruptedIndex)
    .findLast((event) => event.type === "provider-thread.updated");
  assert.equal(
    rosterAtStop?.type === "provider-thread.updated"
      ? rosterAtStop.payload.pendingBackgroundTasks?.length
      : undefined,
    1,
    "the background command stays on the roster when the turn is stopped",
  );

  const wakeMessage = projection.messages.find((message) => message.id === wakeRun?.userMessageId);
  assert.equal(`${wakeMessage?.createdBy}:${wakeMessage?.creationSource}`, "agent:provider");
  assert.deepEqual(
    projection.turnItems.flatMap((item) =>
      item.runId === wakeRun?.id && item.type === "assistant_message" ? [item.text.trim()] : [],
    ),
    ["WAKE_DONE"],
  );
  assert.deepEqual(
    projection.turnItems.flatMap((item) =>
      item.runId === stoppedRun?.id && item.type === "command_execution" ? [item.status] : [],
    ),
    ["completed", "interrupted"],
    "the background launch completed; the foreground command was interrupted",
  );

  assert.deepEqual(projection.providerThreads[0]?.pendingBackgroundTasks ?? [], []);
  const shell = result.shellSnapshot.threads.find((thread) => thread.id === projection.thread.id);
  assert.deepEqual(shell?.pendingBackgroundTasks ?? [], []);
}
