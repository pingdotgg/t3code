import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { CLAUDE_BACKGROUND_TASK_INTERRUPT_PROMPT } from "./input.ts";

const BACKGROUND_TASK_ID = "bt3kw2qpn";

// Interrupting a turn tears down its CLI process, which kills the background
// task it started. The roster must clear with the interrupt, and no wake or
// continuation may follow.
export function assertClaudeBackgroundTaskInterruptOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["interrupted"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [CLAUDE_BACKGROUND_TASK_INTERRUPT_PROMPT]);

  const rosterIndex = result.domainEvents.findIndex(
    (event) =>
      event.type === "provider-thread.updated" &&
      event.payload.pendingBackgroundTasks?.some((task) => task.taskId === BACKGROUND_TASK_ID),
  );
  const interruptedIndex = result.domainEvents.findIndex(
    (event) => event.type === "run.updated" && event.payload.status === "interrupted",
  );
  assert.isAtLeast(rosterIndex, 0, "the background task must reach the roster before interrupt");
  assert.isAbove(interruptedIndex, rosterIndex);
  assert.equal(projection.providerThreads[0]?.status, "idle");
  assert.deepEqual(projection.providerThreads[0]?.pendingBackgroundTasks ?? [], []);
  const shell = result.shellSnapshot.threads.find((thread) => thread.id === projection.thread.id);
  assert.deepEqual(shell?.pendingBackgroundTasks ?? [], []);

  assert.lengthOf(projection.subagents, 0);
  assert.deepEqual(
    projection.turnItems.flatMap((item) =>
      item.type === "command_execution" ? [item.status] : [],
    ),
    ["completed", "failed"],
    "the background launch completed; the interrupted foreground command did not",
  );
}
