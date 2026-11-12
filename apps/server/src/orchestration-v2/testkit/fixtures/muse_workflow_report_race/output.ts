import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { projectionFor } from "../shared.ts";

// Muse finishes the workflow under the launching turn ~10 ms before it starts the report turn.
export function assertMuseWorkflowReportRaceOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  assert.deepEqual(
    projection.runs.map((run) => run.status),
    ["completed", "completed"],
  );
  const workflow = projection.turnItems.find(
    (item) => item.type === "dynamic_tool" && item.toolName === "workflow",
  );
  assert.isDefined(workflow, "the workflow shows as a row");
  assert.equal(workflow.status, "completed");
  assert.deepEqual(projection.providerThreads[0]?.pendingBackgroundTasks ?? [], []);
}
