import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TURN_INTERRUPT_PROMPT,
} from "../shared.ts";

/**
 * Stop while Muse works on a `sleep 30` request: T3 sends `turn/interrupt`, Muse
 * ends the turn as cancelled, and the run, every row and the session settle.
 */
export function assertMuseTurnInterruptOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["interrupted"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [TURN_INTERRUPT_PROMPT]);
  const outbound = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" ? [entry.frame] : [],
  );
  assert.isTrue(
    outbound.some(
      (frame) =>
        typeof frame === "object" &&
        frame !== null &&
        Reflect.get(frame, "method") === "turn/interrupt",
    ),
    "Stop must reach Muse as turn/interrupt",
  );
  assert.isFalse(projection.turnItems.some((item) => item.status === "running"));
  assert.equal(projection.providerThreads[0]?.status, "idle");
  assert.equal(projection.providerTurns[0]?.status, "interrupted");
}
