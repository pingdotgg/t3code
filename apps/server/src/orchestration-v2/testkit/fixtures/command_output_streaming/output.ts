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

/**
 * A command that prints for a few seconds streams its output live, and that
 * output never becomes an orchestration event: the command item is persisted
 * while running with no output, then once with its final output.
 */
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

  // Live output reached the hub, cleaned of escapes and the progress redraw.
  const streamed = result.commandOutput?.get(command.id);
  assert.isDefined(streamed, "the running command must stream its output");
  assert.isAbove(streamed?.chunks ?? 0, 0);
  const liveText = streamed?.output.text ?? "";
  const live = terminalOutputPlainText(liveText);
  // Codex never streams what a command prints before its first yield (the recorded
  // session has no delta, and no aggregatedOutput, for line 1), so it is not asserted.
  for (const line of ["stream line 2", "stream line 3", "stream line 4", "progress 100%"]) {
    assert.include(live, line);
  }
  // The command's green survives as a canonical colour code; nothing else does.
  assert.include(liveText, "\u001b[0;32mstream line 2\u001b[0m");
  assert.notInclude(live, "\u001b");
  assert.notInclude(live, "progress 50%");
  // What viewers watched is the end of what the row keeps once it settles.
  const final = terminalOutputPlainText(normalizeTerminalOutput(command.output ?? "").text);
  assert.isTrue(
    final.trimEnd().endsWith(live.trimEnd()),
    `the live tail must agree with the persisted final output: ${JSON.stringify({ final, live })}`,
  );
  // The row shows what the command printed, not a serialized tool result.
  assert.notInclude(final, '"stdout"');

  // Never persisted while running: no event carries partial command output.
  const commandEvents = result.domainEvents.flatMap((event) =>
    event.type === "turn-item.updated" && event.payload.id === command.id ? [event.payload] : [],
  );
  for (const item of commandEvents) {
    if (item.type !== "command_execution" || item.status === "completed") continue;
    assert.isUndefined(item.output, "a running command item must not persist live output");
  }
}
