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
import { GROK_MONITOR_PROMPT, GROK_MONITOR_TICKS } from "./input.ts";

// Grok streams each monitor tick as an in_progress Bash result that already
// carries exit_code 0 and ends the monitor only through `_x.ai/task_completed`.
// Run 1 is held open until that end; Grok's own reply to the finished monitor
// then arrives as a continuation run, like Claude and Codex background wakes.
export function assertGrokMonitorOutput(
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
  assertUserMessagesInclude(projection, [GROK_MONITOR_PROMPT]);

  const [rootRun, wakeRun] = projection.runs;
  const monitors = projection.turnItems.filter((item) => item.type === "command_execution");
  assert.lengthOf(monitors, 1);
  const monitor = monitors[0];
  assert.equal(monitor?.runId, rootRun?.id, "the monitor belongs to the run that started it");
  assert.equal(monitor?.status, "completed");
  assert.equal(monitor?.output, GROK_MONITOR_TICKS.map((tick) => `${tick}\n`).join(""));

  // Every tick before the end is shown running, with the output so far.
  const monitorUpdates = result.domainEvents.flatMap((event) =>
    event.type === "turn-item.updated" &&
    event.payload.id === monitor?.id &&
    event.payload.type === "command_execution"
      ? [event.payload]
      : [],
  );
  const firstCompleted = monitorUpdates.findIndex((update) => update.status === "completed");
  for (const tick of GROK_MONITOR_TICKS.slice(0, -1)) {
    const tickUpdate = monitorUpdates.findIndex((update) => update.output?.includes(tick));
    assert.isAtLeast(tickUpdate, 0, `missing monitor update for ${tick}`);
    assert.isBelow(tickUpdate, firstCompleted, `the monitor completed before ${tick}`);
    assert.equal(monitorUpdates[tickUpdate]?.status, "running", `${tick} must show running`);
  }

  // Run 1 settles only after the monitor's structured end.
  const monitorCompletedAt = result.domainEvents.findIndex(
    (event) =>
      event.type === "turn-item.updated" &&
      event.payload.id === monitor?.id &&
      event.payload.status === "completed",
  );
  const rootCompletedAt = result.domainEvents.findIndex(
    (event) =>
      event.type === "run.updated" &&
      event.payload.id === rootRun?.id &&
      event.payload.status === "completed",
  );
  assert.isAtLeast(monitorCompletedAt, 0);
  assert.isAbove(rootCompletedAt, monitorCompletedAt, "run 1 completed before the monitor ended");

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
    "Grok's reply to the finished monitor must land in the continuation run",
  );
}
