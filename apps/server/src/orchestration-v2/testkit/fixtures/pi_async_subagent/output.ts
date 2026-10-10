import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import {
  PI_ASYNC_SUBAGENT_AGENT,
  PI_ASYNC_SUBAGENT_PROMPT,
  PI_ASYNC_SUBAGENT_TASK,
} from "./input.ts";

/**
 * The async child shows as one subagent of run 1 that is still running when
 * run 1's turn ends. Its completion notice settles it before the wake starts
 * continuation run 2, so the row never waits on the turn its result triggers.
 */
export function assertPiAsyncSubagentOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [PI_ASYNC_SUBAGENT_PROMPT]);
  assertAssistantTextIncludes(projection, "ROOT_STARTED");
  assertAssistantTextIncludes(projection, "ROOT_WAKE_DONE");

  assert.lengthOf(projection.runs, 2);
  const [launchRun, wakeRun] = projection.runs;
  assert.lengthOf(projection.subagents, 1);
  const subagent = projection.subagents[0];
  assert.equal(subagent?.origin, "provider_native");
  assert.equal(subagent?.title, PI_ASYNC_SUBAGENT_AGENT);
  assert.equal(subagent?.prompt, PI_ASYNC_SUBAGENT_TASK);
  assert.equal(subagent?.status, "completed");
  assert.equal(subagent?.runId, launchRun?.id);
  assert.isNull(subagent?.childThreadId);
  assert.include(subagent?.result ?? "", "ECHO_DONE");
  const subagentItem = projection.turnItems.find(
    (item) => item.type === "subagent" && item.subagentId === subagent?.id,
  );
  assert.equal(subagentItem?.status, "completed");
  assert.equal(subagentItem?.runId, launchRun?.id);
  assert.equal(projection.nodes.find((node) => node.id === subagent?.id)?.status, "completed");

  const indexOf = (
    label: string,
    matches: (event: (typeof result.domainEvents)[number]) => boolean,
  ) => {
    const index = result.domainEvents.findIndex(matches);
    assert.isAtLeast(index, 0, `${label} is stored`);
    return index;
  };
  const running = indexOf(
    "the running subagent",
    (event) =>
      event.type === "subagent.updated" &&
      event.payload.id === subagent?.id &&
      event.payload.status === "running",
  );
  const launchTurnEnd = indexOf(
    "the end of run 1's turn",
    (event) =>
      event.type === "run.updated" &&
      event.payload.id === launchRun?.id &&
      event.payload.status === "waiting",
  );
  const completed = indexOf(
    "the completed subagent",
    (event) =>
      event.type === "subagent.updated" &&
      event.payload.id === subagent?.id &&
      event.payload.status === "completed",
  );
  const wakeStart = indexOf(
    "the start of continuation run 2",
    (event) =>
      event.type === "run.updated" &&
      event.payload.id === wakeRun?.id &&
      event.payload.status === "starting",
  );
  assert.isBelow(running, launchTurnEnd, "the subagent is running before run 1's turn ends");
  assert.isBelow(launchTurnEnd, completed, "the subagent outlives run 1's turn");
  assert.isBelow(
    completed,
    wakeStart,
    "the completion notice settles the subagent before the wake",
  );
}
