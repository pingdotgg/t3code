import { assert } from "@effect/vitest";
import type { OrchestrationV2ThreadProjection, ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  backgroundNotifications,
  projectionFor,
} from "../shared.ts";
import { CLAUDE_BACKGROUND_TASK_LAST_REQUEST_PROMPT } from "./input.ts";

const BACKGROUND_TASK_ID = "b80cmxx3h";

function runAssistantTexts(
  projection: OrchestrationV2ThreadProjection,
  runId: string | undefined,
): ReadonlyArray<string> {
  return projection.turnItems.flatMap((item) =>
    item.runId === runId && item.type === "assistant_message" ? [item.text.trim()] : [],
  );
}

export function assertClaudeBackgroundTaskLastRequestOutput(
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
  assertUserMessagesInclude(projection, [CLAUDE_BACKGROUND_TASK_LAST_REQUEST_PROMPT]);

  const [rootRun, wakeRun] = projection.runs;
  assert.isDefined(rootRun);
  assert.isDefined(wakeRun);
  assert.match(runAssistantTexts(projection, rootRun.id).join("\n"), /^one\ntwo\nthree\n/u);
  assert.deepEqual(runAssistantTexts(projection, wakeRun.id), ["WAKE_DONE"]);

  // The notification arrived during the final request, so the root run ends with the task still
  // owed: a settle or a finished delegate's release must not close the session under the wake.
  const rootCompletedIndex = result.domainEvents.findIndex(
    (event) =>
      event.type === "run.updated" &&
      event.runId === rootRun.id &&
      event.payload.status === "completed",
  );
  const rosterAtRootEnd = result.domainEvents
    .slice(0, rootCompletedIndex)
    .findLast((event) => event.type === "provider-thread.updated");
  assert.isAbove(rootCompletedIndex, 0);
  assert.deepEqual(
    rosterAtRootEnd?.type === "provider-thread.updated"
      ? (rosterAtRootEnd.payload.pendingBackgroundTasks ?? []).map((task) => task.taskId)
      : undefined,
    [BACKGROUND_TASK_ID],
  );
  assert.deepEqual(projection.providerThreads[0]?.pendingBackgroundTasks ?? [], []);
  assert.deepEqual(backgroundNotifications(projection), [
    {
      summary: 'Command "Background sleep then echo" finished',
      outcome: "completed",
      source: { kind: "command" },
    },
  ]);
}
