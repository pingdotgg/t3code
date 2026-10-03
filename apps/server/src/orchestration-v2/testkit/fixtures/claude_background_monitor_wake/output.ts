import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  backgroundNotifications,
  projectionFor,
} from "../shared.ts";
import { CLAUDE_BACKGROUND_MONITOR_WAKE_PROMPT } from "./input.ts";

const MONITOR_TASK_ID = "b1htjkjev";

// Claude reports a Monitor as task_type local_bash, the same as a background
// Bash command. Only the Monitor tool call that started the task tells them
// apart, so the roster and the wake must name it a monitor.
export function assertClaudeBackgroundMonitorWakeOutput(
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
  assertUserMessagesInclude(projection, [CLAUDE_BACKGROUND_MONITOR_WAKE_PROMPT]);

  const rosterTasks = result.domainEvents
    .flatMap((event) =>
      event.type === "provider-thread.updated" ? (event.payload.pendingBackgroundTasks ?? []) : [],
    )
    .filter((task) => task.taskId === MONITOR_TASK_ID);
  // Claude's first roster snapshot lands one frame before the task_started
  // that links the task to its Monitor call, so only that entry reads command.
  assert.isAbove(rosterTasks.length, 1);
  for (const task of rosterTasks.slice(1)) {
    const { startedAt, ...named } = task;
    assert.deepEqual(named, {
      taskId: MONITOR_TASK_ID,
      description: "Background monitor test",
      command: "sleep 8 && echo MONITOR_DONE",
      kind: "monitor",
    });
    assert.isString(startedAt);
  }
  assert.deepEqual(projection.providerThreads[0]?.pendingBackgroundTasks ?? [], []);

  assert.deepEqual(backgroundNotifications(projection), [
    {
      summary: 'Monitor "Background monitor test" finished',
      outcome: "completed",
      source: { kind: "monitor" },
    },
  ]);

  const [rootRun, wakeRun] = projection.runs;
  const assistantTexts = (runId: string | undefined) =>
    projection.turnItems.flatMap((item) =>
      item.runId === runId && item.type === "assistant_message" ? [item.text.trim()] : [],
    );
  assert.deepEqual(assistantTexts(rootRun?.id), ["STARTED"]);
  assert.deepEqual(assistantTexts(wakeRun?.id), ["WAKE_DONE"]);

  assert.lengthOf(projection.subagents, 0);
}
