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

/**
 * A foreground subagent starts a background one and returns, so the
 * thread's turn ends while that grandchild runs. Ending the foreground call
 * leaves the grandchild running: the run waits on it, its report reaches
 * the subagent that started it, and that subagent's answer is a second turn
 * on its own thread. Only then does the run complete.
 */
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
  // The grandchild ran to its own end instead of being stopped with its caller.
  assert.lengthOf(middleThread.subagents, 1);
  const grandchild = middleThread.subagents[0]!;
  assert.deepInclude(grandchild, { status: "completed", result: "GRANDCHILD_OK" });
  assert.deepEqual(texts(result.projections.get(grandchild.childThreadId!)), ["GRANDCHILD_OK"]);
  // The middle subagent answered the report in a turn of its own.
  assert.deepEqual(texts(middleThread), ["MIDDLE_OK", "GRANDCHILD_OK"]);

  // The run waited on the grandchild: it completed after the grandchild did.
  const indexOf = (predicate: (event: (typeof result.domainEvents)[number]) => boolean) =>
    result.domainEvents.findIndex(predicate);
  const rootTurnEnded = indexOf(
    (event) =>
      event.type === "run.updated" &&
      event.payload.id === projection.runs[0]?.id &&
      event.payload.status === "waiting",
  );
  const grandchildDone = indexOf(
    (event) =>
      event.type === "subagent.updated" &&
      event.payload.id === grandchild.id &&
      event.payload.status === "completed",
  );
  const runCompleted = indexOf(
    (event) =>
      event.type === "run.updated" &&
      event.payload.id === projection.runs[0]?.id &&
      event.payload.status === "completed",
  );
  assert.isAtLeast(rootTurnEnded, 0);
  assert.isAbove(grandchildDone, rootTurnEnded, "the thread's turn ends before the grandchild");
  assert.isAbove(runCompleted, grandchildDone, "the run waits for the grandchild");

  const shell = result.shellSnapshot.threads.find((thread) => thread.id === projection.thread.id);
  assert.deepEqual(shell?.pendingBackgroundTasks ?? [], []);
}
