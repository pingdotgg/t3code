import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  OPENCODE2_COMMAND_PROMPT,
  projectionFor,
} from "../shared.ts";

/**
 * `/hello WORLD` names a workspace command, so it runs through
 * `session.command` and OpenCode expands the template ("Reply with exactly:
 * HELLO $ARGUMENTS") in its own execution, which ends the turn.
 */
export function assertOpenCode2CommandOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [OPENCODE2_COMMAND_PROMPT]);
  assertAssistantTextIncludes(projection, "HELLO WORLD");
  assert.deepEqual(
    projection.providerTurns.map((turn) => turn.status),
    ["completed"],
  );
}
