import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
} from "../shared.ts";
import { CLAUDE_AUTO_MODE_PROMPT } from "./input.ts";

/** Claude's init reports auto mode: it approves the write itself and the thread shows no notice. */
export function assertClaudeAutoModeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [CLAUDE_AUTO_MODE_PROMPT]);
  assertRuntimeRequestCounts(projection, { total: 0, resolved: 0 });
  assert.lengthOf(
    projection.turnItems.filter((item) => item.type === "system_notice"),
    0,
  );
}
