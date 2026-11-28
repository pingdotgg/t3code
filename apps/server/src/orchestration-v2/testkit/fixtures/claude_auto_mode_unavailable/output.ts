import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAllRuntimeRequestsResolved,
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertRuntimeRequestKinds,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
} from "../shared.ts";
import { CLAUDE_AUTO_MODE_PROMPT } from "../claude_auto_mode/input.ts";

/**
 * The project's settings turn auto mode off, so Claude's init reports `default`: the thread asks
 * about the write and says once why. The reason is not asserted, because the settings of the
 * machine running the test can add a broader one.
 */
export function assertClaudeAutoModeUnavailableOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [CLAUDE_AUTO_MODE_PROMPT]);
  assertRuntimeRequestCounts(projection, { total: 1, resolved: 1 });
  assertRuntimeRequestKinds(projection, ["file-change"]);
  assertAllRuntimeRequestsResolved(projection);

  const notices = projection.turnItems.flatMap((item) =>
    item.type === "system_notice" ? [item.message] : [],
  );
  assert.lengthOf(notices, 1);
  assert.include(notices[0], "Asking about each action");
}
