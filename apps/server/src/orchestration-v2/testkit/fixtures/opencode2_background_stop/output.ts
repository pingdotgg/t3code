import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  OPENCODE2_BACKGROUND_STOP_PROMPT,
  projectionFor,
} from "../shared.ts";

export function assertOpenCode2BackgroundStopOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const shellCreatedIndex = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "shell.created",
  );
  const interruptIndex = transcript.entries.findIndex(
    (entry) => entry.type === "expect_outbound" && entry.label === "session.interrupt",
  );
  const shellRemoveIndex = transcript.entries.findIndex(
    (entry) => entry.type === "expect_outbound" && entry.label === "shell.remove",
  );
  assert.isAtLeast(shellCreatedIndex, 0);
  assert.isAbove(interruptIndex, shellCreatedIndex);
  assert.isAbove(shellRemoveIndex, interruptIndex);

  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["interrupted"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertTurnItemTypes(projection, [
    "user_message",
    "command_execution",
    "run_interrupt_request",
    "run_interrupt_result",
  ]);
  assertUserMessagesInclude(projection, [OPENCODE2_BACKGROUND_STOP_PROMPT]);

  const commands = projection.turnItems.filter((item) => item.type === "command_execution");
  assert.equal(commands.length, 1, "tool and shell events must retain one interrupted command row");
  assert.equal(commands[0]?.status, "interrupted");
  assert.include(commands[0]?.input ?? "", "background stop should not finish");
  assert.notInclude(commands[0]?.output ?? "", "background stop should not finish");
  assert.deepEqual(
    projection.attempts.map((attempt) => attempt.status),
    ["interrupted"],
  );
  assert.equal(projection.providerTurns[0]?.status, "interrupted");
}
