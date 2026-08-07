import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

const SHARED_OUTPUT = "SHARED_ORDINARY_WAKE_OUTPUT";

export function assertOpenCode2SharedOrdinaryWakeReplayOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const executionStarted = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "shared.execution.started",
  );
  const rootPromoted = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "root.input.promoted.early",
  );
  const wakePromoted = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "wake.input.promoted.late",
  );
  assert.isAtLeast(rootPromoted, 0);
  assert.isAtLeast(executionStarted, 0);
  assert.isAtLeast(wakePromoted, 0);
  assert.isAbove(executionStarted, rootPromoted);
  assert.isAbove(wakePromoted, executionStarted);

  const projection = projectionFor(result, transcript.scenario);
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  assertSemanticProjectionIntegrity(projection);
  assertAssistantTextIncludes(projection, SHARED_OUTPUT);

  const sharedItems = projection.turnItems.filter(
    (item) => item.type === "assistant_message" && item.text.includes(SHARED_OUTPUT),
  );
  assert.lengthOf(sharedItems, 1);
  assert.equal(sharedItems[0]?.runId, projection.runs[0]?.id);
}
