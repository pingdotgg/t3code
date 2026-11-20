import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";
import { normalizeTerminalOutput, terminalOutputPlainText } from "@t3tools/shared/terminalOutput";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  COMMAND_OUTPUT_STREAMING_PROMPT,
  projectionFor,
} from "../shared.ts";

export function assertCommandOutputStreamingOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [COMMAND_OUTPUT_STREAMING_PROMPT]);

  const command = projection.turnItems.find((item) => item.type === "command_execution");
  assert.isDefined(command);
  assert.equal(command?.type, "command_execution");
  if (command?.type !== "command_execution") return;
  assert.equal(command.status, "completed");
  assert.include(command.output ?? "", "progress 100%");

  const streamed = result.commandOutput?.get(command.id);
  assert.isDefined(streamed, "the running command must stream its output");
  assert.isAbove(streamed?.chunks ?? 0, 0);
  const liveText = streamed?.output.text ?? "";
  const live = terminalOutputPlainText(liveText);
  // Codex omits pre-yield command output; the recording has no delta or aggregatedOutput for line 1.
  for (const line of ["stream line 2", "stream line 3", "stream line 4", "progress 100%"]) {
    assert.include(live, line);
  }
  assert.include(liveText, "\u001b[0;32mstream line 2\u001b[0m");
  assert.notInclude(live, "\u001b");
  assert.notInclude(live, "progress 50%");
  const final = terminalOutputPlainText(normalizeTerminalOutput(command.output ?? "").text);
  assert.isTrue(
    final.trimEnd().endsWith(live.trimEnd()),
    `the live tail must agree with the persisted final output: ${JSON.stringify({ final, live })}`,
  );
  assert.notInclude(final, '"stdout"');

  const commandEvents = result.domainEvents.flatMap((event) =>
    event.type === "turn-item.updated" && event.payload.id === command.id ? [event.payload] : [],
  );
  for (const item of commandEvents) {
    if (item.type !== "command_execution" || item.status === "completed") continue;
    assert.isUndefined(item.output, "a running command item must not persist live output");
  }
}
