import { assert } from "@effect/vitest";
import type { OrchestrationV2ThreadProjection, ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertProviderNativeSubagentRootTurns,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  OPENCODE2_NESTED_BACKGROUND_PROMPT,
  projectionFor,
} from "../shared.ts";

const texts = (projection: OrchestrationV2ThreadProjection | undefined) =>
  (projection?.turnItems ?? []).flatMap((item) =>
    item.type === "assistant_message" ? [item.text.trim()] : [],
  );

export function assertOpenCode2NestedBackgroundOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertProviderNativeSubagentRootTurns(result);
  assertUserMessagesInclude(projection, [OPENCODE2_NESTED_BACKGROUND_PROMPT]);
  assert.deepEqual(texts(projection), ["ROOT_OK"]);

  const [middle] = projection.subagents;
  assert.lengthOf(projection.subagents, 1);
  assert.deepInclude(middle, { status: "completed", result: "MIDDLE_OK" });
  const middleThread = result.projections.get(middle!.childThreadId!);
  assert.isDefined(middleThread);
  assert.lengthOf(middleThread.subagents, 1);
  const grandchild = middleThread.subagents[0]!;
  assert.deepInclude(grandchild, { status: "completed", result: "GRANDCHILD_OK" });
  assert.deepEqual(texts(result.projections.get(grandchild.childThreadId!)), ["GRANDCHILD_OK"]);
  assert.deepEqual(texts(middleThread), ["MIDDLE_OK", "GRANDCHILD_OK"]);

  const indexOf = (predicate: (event: (typeof result.domainEvents)[number]) => boolean) =>
    result.domainEvents.findIndex(predicate);
  const rootTurnEnded = indexOf(
    (event) =>
      event.type === "run.updated" &&
      event.payload.id === projection.runs[0]?.id &&
      event.payload.status === "completed",
  );
  const grandchildDone = indexOf(
    (event) =>
      event.type === "subagent.updated" &&
      event.payload.id === grandchild.id &&
      event.payload.status === "completed",
  );
  // The run completes at turn end; its checkpoint capture settles after the grandchild.
  const runCaptured = indexOf(
    (event) =>
      event.type === "run.updated" &&
      event.payload.id === projection.runs[0]?.id &&
      event.payload.checkpointId !== null,
  );
  assert.isAtLeast(rootTurnEnded, 0);
  assert.isAbove(grandchildDone, rootTurnEnded, "the thread's turn ends before the grandchild");
  assert.isAbove(runCaptured, grandchildDone, "the run's capture waits for the grandchild");

  const shell = result.shellSnapshot.threads.find((thread) => thread.id === projection.thread.id);
  assert.deepEqual(shell?.pendingBackgroundTasks ?? [], []);
}
