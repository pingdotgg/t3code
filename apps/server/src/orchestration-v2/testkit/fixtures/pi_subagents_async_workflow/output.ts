import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

const WORKFLOW_RUN_ID = "5284158e-cd8f-474d-9127-68b272fd9aba";

// The launch receipt lists no children; the widget snapshot names them and the notices settle them.
export function assertPiSubagentsAsyncWorkflowOutput(
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
  const launchRun = projection.runs[0];
  if (launchRun === undefined) throw new Error("The launching run is missing.");

  const members = projection.turnItems.flatMap((item) =>
    item.type === "subagent"
      ? [[item.nativeItemRef?.nativeId, item.title, item.status, item.runId] as const]
      : [],
  );
  assert.sameDeepMembers(members, [
    [`${WORKFLOW_RUN_ID}:subagent:alpha`, "scout", "completed", launchRun.id],
    [`${WORKFLOW_RUN_ID}:subagent:beta`, "scout", "completed", launchRun.id],
  ]);
  assert.sameDeepMembers(
    projection.subagents.map((subagent) => [
      subagent.status,
      subagent.runId,
      subagent.childThreadId,
    ]),
    [
      ["completed", launchRun.id, null],
      ["completed", launchRun.id, null],
    ],
  );

  const eventIndex = (predicate: (event: (typeof result.domainEvents)[number]) => boolean) =>
    result.domainEvents.findIndex(predicate);
  const launchRunStatus = (status: string) =>
    eventIndex(
      (event) =>
        event.type === "run.updated" &&
        event.payload.id === launchRun.id &&
        event.payload.status === status,
    );
  // The launching turn is the first provider turn to complete; the wake's comes later.
  const launchTurnEnded = eventIndex(
    (event) => event.type === "provider-turn.updated" && event.payload.status === "completed",
  );
  const memberEvent = (key: string, status: string) =>
    eventIndex(
      (event) =>
        event.type === "turn-item.updated" &&
        event.payload.type === "subagent" &&
        event.payload.nativeItemRef?.nativeId === `${WORKFLOW_RUN_ID}:subagent:${key}` &&
        event.payload.status === status,
    );
  assert.isAtLeast(launchTurnEnded, 0);
  // The launching run waits on its detached children after Pi ends the turn, then completes.
  assert.isAbove(launchRunStatus("waiting"), launchTurnEnded);
  for (const key of ["alpha", "beta"]) {
    assert.isAtLeast(memberEvent(key, "running"), 0, `${key} shows while it runs`);
    if (key === "alpha") assert.isBelow(memberEvent(key, "running"), launchTurnEnded);
    else assert.isAbove(memberEvent(key, "running"), memberEvent("alpha", "completed"));
    assert.isAbove(memberEvent(key, "completed"), launchRunStatus("waiting"));
    assert.isBelow(memberEvent(key, "completed"), launchRunStatus("completed"));
  }
}
