import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypeSequence,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  OPENCODE_ERROR_CLEANUP_DRAIN_PROMPT,
  projectionFor,
} from "../shared.ts";

export function assertOpenCodeErrorCleanupMultipleMessagesOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["failed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertTurnItemTypeSequence(projection, [
    "user_message",
    "command_execution",
    "command_execution",
    "error",
  ]);
  assertUserMessagesInclude(projection, [OPENCODE_ERROR_CLEANUP_DRAIN_PROMPT]);

  const commandItems = projection.turnItems.filter((item) => item.type === "command_execution");
  assert.lengthOf(commandItems, 2);
  assert.deepEqual(
    commandItems.map((item) => [item.status, item.output, item.exitCode]),
    [
      ["completed", "first cleanup result", 0],
      ["completed", "second cleanup result", 0],
    ],
  );
}
