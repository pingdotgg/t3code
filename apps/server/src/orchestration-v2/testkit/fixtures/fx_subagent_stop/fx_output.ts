import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  FX_SUBAGENT_STOP_PROMPT,
  projectionFor,
} from "../shared.ts";

/** fx 0.0.15 fails a sub-agent that Stop cut off; T3 shows it, and its child thread, as interrupted. */
export function assertFxSubagentStopOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["interrupted"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [FX_SUBAGENT_STOP_PROMPT]);
  assert.notInclude(
    projection.turnItems.map((item) => item.type),
    "dynamic_tool",
    "the subagent call must not also show as a tool row",
  );
  assert.lengthOf(projection.subagents, 1);
  const subagent = projection.subagents[0]!;
  assert.equal(subagent.status, "interrupted");
  assert.include(subagent.prompt, "stopped.txt");
  assert.equal(subagent.result, "Cancelled", "fx's error, not its JSON envelope");
  if (subagent.childThreadId === null) throw new Error("The subagent has no child thread");
  assert.equal(
    result.projections.get(subagent.childThreadId)?.thread.lineage.parentThreadId,
    projection.thread.id,
  );
  assert.equal(projection.providerTurns[0]?.status, "interrupted");
  assert.equal(projection.providerThreads[0]?.status, "idle");
}
