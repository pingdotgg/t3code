import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  OPENCODE2_INTERRUPT_PROMPT,
  projectionFor,
} from "../shared.ts";

/**
 * Stop during a running shell call: `session.interrupt`, then OpenCode fails the
 * tool as aborted and ends the execution with `interrupted`.
 */
export function assertOpenCode2InterruptOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["interrupted"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertTurnItemTypes(projection, [
    "user_message",
    "assistant_message",
    "command_execution",
    "run_interrupt_request",
    "run_interrupt_result",
  ]);
  assertUserMessagesInclude(projection, [OPENCODE2_INTERRUPT_PROMPT]);

  const shell = projection.turnItems.find((item) => item.type === "command_execution");
  assert.deepInclude(shell, { input: "sleep 60 && echo LATE", status: "interrupted" });
  assert.equal(
    projection.turnItems.find((item) => item.type === "run_interrupt_result")?.status,
    "interrupted",
  );
  assert.deepEqual(
    projection.providerTurns.map((turn) => turn.status),
    ["interrupted"],
  );
  assert.equal(projection.providerThreads[0]?.status, "idle");
}
