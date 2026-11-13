import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { CLAUDE_BACKGROUND_TASK_AFTER_ROOT_PROMPT } from "./input.ts";

const BACKGROUND_TASK_ID = "bc9gkn8ei";

export function assertClaudeBackgroundTaskAfterRootOutput(
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
  assertUserMessagesInclude(projection, [CLAUDE_BACKGROUND_TASK_AFTER_ROOT_PROMPT]);

  const rootRun = projection.runs[0];
  const wakeRun = projection.runs[1];
  assert.isDefined(rootRun);
  assert.isDefined(wakeRun);
  const pendingRosterIndex = result.domainEvents.findIndex(
    (event) =>
      event.type === "provider-thread.updated" &&
      event.payload.pendingBackgroundTasks?.some((task) => task.taskId === BACKGROUND_TASK_ID),
  );
  const waitingRunIndex = result.domainEvents.findIndex(
    (event) =>
      event.type === "run.updated" &&
      event.runId === rootRun.id &&
      event.payload.status === "waiting",
  );
  const waitingRootNodeIndex = result.domainEvents.findIndex(
    (event) =>
      event.type === "node.updated" &&
      event.payload.runId === rootRun.id &&
      event.payload.kind === "root_turn" &&
      event.payload.status === "waiting",
  );
  const clearedRosterIndex = result.domainEvents.findIndex(
    (event, index) =>
      index > waitingRunIndex &&
      event.type === "provider-thread.updated" &&
      event.payload.pendingBackgroundTasks?.length === 0,
  );
  const wakeRunIndex = result.domainEvents.findIndex(
    (event) => event.type === "run.created" && event.payload.id === wakeRun.id,
  );

  assert.isAtLeast(pendingRosterIndex, 0, "replay must project the live background task roster");
  assert.isAbove(
    waitingRunIndex,
    pendingRosterIndex,
    "checkpoint-waiting root run must retain the background roster",
  );
  assert.isAbove(
    waitingRootNodeIndex,
    pendingRosterIndex,
    "checkpoint-waiting root node must retain the background roster",
  );
  assert.isAbove(wakeRunIndex, waitingRunIndex, "the wake must follow the root turn");
  assert.isAbove(
    clearedRosterIndex,
    wakeRunIndex,
    "the background task must remain pending until its wake run consumes the completion",
  );
  assert.equal(rootRun.status, "completed");
  const rootNode = projection.nodes.find(
    (node) => node.runId === rootRun.id && node.kind === "root_turn",
  );
  assert.isDefined(rootNode);
  assert.equal(rootNode.status, "completed");

  assert.lengthOf(projection.providerThreads, 1);
  assert.equal(projection.providerThreads[0]?.status, "idle");
  assert.deepEqual(projection.providerThreads[0]?.pendingBackgroundTasks ?? [], []);
  assert.lengthOf(projection.subagents, 0);

  const assistantTexts = projection.turnItems.flatMap((item) =>
    item.type === "assistant_message" ? [item.text] : [],
  );
  assert.deepEqual(assistantTexts, ["L2_STARTED", "L2_WAKE: L2_BG_DONE"]);

  const shell = result.shellSnapshot.threads.find((thread) => thread.id === projection.thread.id);
  assert.isDefined(shell);
  assert.equal(shell.activeRunId, null);
  assert.equal(shell.status, "completed");
  assert.deepEqual(shell.pendingBackgroundTasks ?? [], []);
}
