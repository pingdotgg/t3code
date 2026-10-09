import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  backgroundNotifications,
  projectionFor,
} from "../shared.ts";

export function assertGrokBackgroundBashKilledOutput(
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
    commands.map((command) => ({ runId: command.runId, status: command.status })),
    [
      { runId: rootRun?.id ?? null, status: "completed" as const },
      { runId: rootRun?.id ?? null, status: "completed" as const },
    ],
  );
  const second = commands[1];
  assert.equal(second?.output, "second done\n");

  // Run 1 settles only after the command that outlived the turn ended.
  const secondCompletedAt = result.domainEvents.findIndex(
    (event) =>
      event.type === "turn-item.updated" &&
      event.payload.id === second?.id &&
      event.payload.status === "completed",
  );
  const rootCompletedAt = result.domainEvents.findIndex(
    (event) =>
      event.type === "run.updated" &&
      event.payload.id === rootRun?.id &&
      event.payload.status === "completed",
  );
  assert.isAtLeast(secondCompletedAt, 0);
  assert.isAbove(rootCompletedAt, secondCompletedAt, "run 1 completed before the command ended");

  assert.deepEqual(backgroundNotifications(projection), [
    {
      summary: 'Command "Wait for the second step" finished (exit 0)',
      outcome: "completed",
      source: { kind: "command" },
    },
  ]);
  const wakeMessage = projection.messages.find((message) => message.id === wakeRun?.userMessageId);
  assert.equal(`${wakeMessage?.createdBy}:${wakeMessage?.creationSource}`, "agent:provider");
}
