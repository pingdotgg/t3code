import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  backgroundNotifications,
  projectionFor,
} from "../shared.ts";

export function assertGrokBackgroundBashUnpolledOutput(
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

  const [rootRun, wakeRun] = projection.runs;
  const commands = projection.turnItems.filter((item) => item.type === "command_execution");
  assert.deepEqual(
    commands.map((command) => ({
      runId: command.runId,
      status: command.status,
      output: command.output,
    })),
    [{ runId: rootRun?.id ?? null, status: "completed" as const, output: "warmed\n" }],
  );
  assert.lengthOf(backgroundNotifications(projection), 1, "one continuation for the wake");
  const wakeMessage = projection.messages.find((message) => message.id === wakeRun?.userMessageId);
  assert.equal(`${wakeMessage?.createdBy}:${wakeMessage?.creationSource}`, "agent:provider");
  assert.include(
    projection.turnItems.flatMap((item) =>
      item.runId === wakeRun?.id && item.type === "assistant_message" ? [item.text.trim()] : [],
    ),
    "warmed",
  );
}
