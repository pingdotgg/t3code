import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
} from "../shared.ts";
import { GROK_BACKGROUND_BASH_PROMPT, GROK_BACKGROUND_BASH_TICKS } from "./input.ts";

// Grok completes a background shell command's tool call with a
// `BackgroundTaskStarted` acknowledgement while the process keeps running,
// streams its output afterwards, and ends it only with `x.ai/task_completed`.
// Like a monitor, the command stays in the run that started it and holds that
// run open; Grok's own reply to the finished command is a continuation run.
export function assertGrokBackgroundBashOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [GROK_BACKGROUND_BASH_PROMPT]);

  const [rootRun, wakeRun] = projection.runs;
  const commands = projection.turnItems.filter((item) => item.type === "command_execution");
  assert.lengthOf(commands, 1);
  const command = commands[0];
  assert.equal(command?.runId, rootRun?.id, "the command belongs to the run that started it");
  assert.equal(command?.status, "completed");
  assert.equal(command?.output, GROK_BACKGROUND_BASH_TICKS.map((tick) => `${tick}\n`).join(""));

  // The start acknowledgement does not finish the command: every tick before
  // the end is shown running.
  const commandUpdates = result.domainEvents.flatMap((event) =>
    event.type === "turn-item.updated" &&
    event.payload.id === command?.id &&
    event.payload.type === "command_execution"
      ? [event.payload]
      : [],
  );
  const firstCompleted = commandUpdates.findIndex((update) => update.status === "completed");
  for (const tick of GROK_BACKGROUND_BASH_TICKS.slice(0, -1)) {
    const tickUpdate = commandUpdates.findIndex((update) => update.output?.includes(tick));
    assert.isAtLeast(tickUpdate, 0, `missing command update for ${tick}`);
    assert.isBelow(tickUpdate, firstCompleted, `the command completed before ${tick}`);
    assert.equal(commandUpdates[tickUpdate]?.status, "running", `${tick} must show running`);
  }

  // Run 1 settles only after the command's structured end.
  const commandCompletedAt = result.domainEvents.findIndex(
    (event) =>
      event.type === "turn-item.updated" &&
      event.payload.id === command?.id &&
      event.payload.status === "completed",
  );
  const rootCompletedAt = result.domainEvents.findIndex(
    (event) =>
      event.type === "run.updated" &&
      event.payload.id === rootRun?.id &&
      event.payload.status === "completed",
  );
  assert.isAtLeast(commandCompletedAt, 0);
  assert.isAbove(rootCompletedAt, commandCompletedAt, "run 1 completed before the command ended");

  const rootTexts = projection.turnItems.flatMap((item) =>
    item.runId === rootRun?.id && item.type === "assistant_message" ? [item.text.trim()] : [],
  );
  assert.include(rootTexts, "ROOT_DONE");

  // Grok's own wake reply is a provider continuation, not more of run 1.
  const wakeMessage = projection.messages.find((message) => message.id === wakeRun?.userMessageId);
  assert.equal(`${wakeMessage?.createdBy}:${wakeMessage?.creationSource}`, "agent:provider");
  assert.isNotEmpty(
    projection.turnItems.filter(
      (item) => item.runId === wakeRun?.id && item.type === "assistant_message",
    ),
    "Grok's reply to the finished command must land in the continuation run",
  );
}
