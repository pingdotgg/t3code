import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import {
  KIRO_MODEL_SWITCH_FIRST_PROMPT,
  KIRO_MODEL_SWITCH_SECOND_PROMPT,
  KIRO_MODEL_SWITCH_TARGET,
} from "./input.ts";

interface Frame {
  readonly kind?: unknown;
  readonly method?: unknown;
  readonly params?: { readonly configId?: unknown; readonly value?: unknown };
}

/** The second turn runs on the newly picked model in the same Kiro session. */
export function assertKiroModelSwitchOutput(
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
  assertUserMessagesInclude(projection, [
    KIRO_MODEL_SWITCH_FIRST_PROMPT,
    KIRO_MODEL_SWITCH_SECOND_PROMPT,
  ]);

  const outbound = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" && (entry.frame as Frame).kind === "request"
      ? [entry.frame as Frame]
      : [],
  );
  assert.equal(
    outbound.filter((frame) => frame.method === "session/new").length,
    1,
    "the switch must reuse the live session",
  );
  const modelWrites = outbound.flatMap((frame) =>
    frame.method === "session/set_config_option" && frame.params?.configId === "model"
      ? [frame.params.value]
      : [],
  );
  assert.equal(modelWrites.at(-1), KIRO_MODEL_SWITCH_TARGET);
  assert.equal(projection.runs.at(-1)?.modelSelection.model, KIRO_MODEL_SWITCH_TARGET);
}
