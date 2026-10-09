import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  backgroundNotifications,
  projectionFor,
} from "../shared.ts";

export function assertGrokBackgroundBashPolledOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);

  const rootRun = projection.runs[0];
  const commands = projection.turnItems.filter((item) => item.type === "command_execution");
  assert.deepEqual(
    commands.map((command) => ({
      runId: command.runId,
      status: command.status,
      output: command.output,
    })),
    // The lint command's task_completed carried no output, so its row shows
    // the poll result, which Grok reports trimmed.
    ["build ok\n", "lint ok", "test ok\n"].map((output) => ({
      runId: rootRun?.id ?? null,
      status: "completed" as const,
      output,
    })),
  );
  assert.include(
    projection.turnItems.flatMap((item) =>
      item.type === "assistant_message" ? [item.text.trim()] : [],
    ),
    "POLLED_DONE",
  );
  // The agent read every result itself, so no continuation reports them.
  assert.deepEqual(backgroundNotifications(projection), []);
}
