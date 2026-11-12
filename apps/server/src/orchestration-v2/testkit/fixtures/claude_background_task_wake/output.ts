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
import {
  CLAUDE_BACKGROUND_TASK_WAKE_FOLLOW_UP_PROMPT,
  CLAUDE_BACKGROUND_TASK_WAKE_PROMPT,
} from "./input.ts";

const BACKGROUND_TASK_ID = "bdqirlcyw";
const WAKE_SUMMARY = 'Background command "Background sleep test" completed (exit code 0)';

function runAssistantTexts(
  projection: OrchestrationV2ThreadProjection,
  runId: string | undefined,
): ReadonlyArray<string> {
  return projection.turnItems.flatMap((item) =>
    item.runId === runId && item.type === "assistant_message" ? [item.text.trim()] : [],
  );
}

export function assertClaudeBackgroundTaskWakeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 3,
    runStatuses: ["completed", "completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [
    CLAUDE_BACKGROUND_TASK_WAKE_PROMPT,
    CLAUDE_BACKGROUND_TASK_WAKE_FOLLOW_UP_PROMPT,
  ]);

  const [rootRun, wakeRun, userRun] = projection.runs;
  assert.deepEqual(runAssistantTexts(projection, rootRun?.id), ["STARTED"]);
  assert.deepEqual(runAssistantTexts(projection, wakeRun?.id), ["WAKE_DONE"]);
  assert.deepEqual(runAssistantTexts(projection, userRun?.id), ["USER_REPLY"]);

  const creators = projection.runs.map((run) => {
    const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
    return `${message?.createdBy}:${message?.creationSource}`;
  });
  assert.deepEqual(creators, ["user:web", "agent:provider", "user:web"]);
  const wakeMessage = projection.messages.find((message) => message.id === wakeRun?.userMessageId);
  assert.equal(wakeMessage?.text, WAKE_SUMMARY);

  const rosterIndex = result.domainEvents.findIndex(
    (event) =>
      event.type === "provider-thread.updated" &&
      event.payload.pendingBackgroundTasks?.some((task) => task.taskId === BACKGROUND_TASK_ID),
  );
  const clearedIndex = result.domainEvents.findIndex(
    (event, index) =>
      index > rosterIndex &&
      event.type === "provider-thread.updated" &&
      (event.payload.pendingBackgroundTasks?.length ?? 0) === 0,
  );
  assert.isAtLeast(rosterIndex, 0, "the running background task must reach the roster");
  assert.isAbove(clearedIndex, rosterIndex, "the completed task must leave the roster");
  assert.deepEqual(projection.providerThreads[0]?.pendingBackgroundTasks ?? [], []);

  const rosterTask = result.domainEvents
    .flatMap((event) =>
      event.type === "provider-thread.updated" ? (event.payload.pendingBackgroundTasks ?? []) : [],
    )
    .find((task) => task.taskId === BACKGROUND_TASK_ID);
  assert.deepEqual(rosterTask, {
    taskId: BACKGROUND_TASK_ID,
    description: "Background sleep test",
    kind: "command",
  });
  assert.deepEqual(backgroundNotifications(projection), [
    {
      summary: 'Command "Background sleep test" finished',
      outcome: "completed",
      source: { kind: "command" },
    },
  ]);

  assert.lengthOf(projection.subagents, 0);
  assert.isFalse(projection.nodes.some((node) => node.kind === "subagent"));
}
