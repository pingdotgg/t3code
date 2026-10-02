import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  OPENCODE2_SKILL_PROMPT,
  projectionFor,
} from "../shared.ts";

/**
 * `$greet` names a workspace skill, so the prompt attaches it natively
 * (`prompt{skills:[{id:"greet"}]}`, checked by the transcript) and the model
 * follows it: the skill says to open with MANGO.
 */
export function assertOpenCode2SkillOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [OPENCODE2_SKILL_PROMPT]);
  assertAssistantTextIncludes(projection, "MANGO");
  assert.deepEqual(
    projection.providerTurns.map((turn) => turn.status),
    ["completed"],
  );
}
