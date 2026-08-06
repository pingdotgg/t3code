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

function eventType(frame: unknown): string | undefined {
  if (typeof frame !== "object" || frame === null || Reflect.get(frame, "type") !== "sdk.event") {
    return undefined;
  }
  const event = Reflect.get(frame, "event");
  return typeof event === "object" && event !== null
    ? (Reflect.get(event, "type") as string | undefined)
    : undefined;
}

export function assertOpenCodeErrorCleanupDrainOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const errorIndex = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && eventType(entry.frame) === "session.error",
  );
  const idleIndex = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && eventType(entry.frame) === "session.idle",
  );
  const lateToolIndex = transcript.entries.findIndex(
    (entry) =>
      entry.type === "emit_inbound" && entry.label === "message.part.updated.tool.completed.late",
  );

  assert.isAtLeast(errorIndex, 0);
  if (transcript.scenario === "opencode_error_cleanup_no_pre_idle") {
    assert.isAbove(lateToolIndex, errorIndex);
    assert.isAbove(idleIndex, lateToolIndex);
  } else {
    assert.isAbove(idleIndex, errorIndex);
    assert.isAbove(lateToolIndex, idleIndex);
  }
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["failed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertTurnItemTypeSequence(projection, ["user_message", "command_execution", "error"]);
  assertUserMessagesInclude(projection, [OPENCODE_ERROR_CLEANUP_DRAIN_PROMPT]);

  const commandItem = projection.turnItems.find((item) => item.type === "command_execution");
  assert.isDefined(commandItem);
  if (commandItem.type !== "command_execution") throw new Error("expected command item");
  assert.equal(commandItem.status, "completed");
  assert.equal(commandItem.title, "Capture cleanup result");
  assert.equal(commandItem.output, "authoritative cleanup result");
  assert.equal(commandItem.exitCode, 0);

  const errorItem = projection.turnItems.find((item) => item.type === "error");
  assert.isDefined(errorItem);
  if (errorItem.type !== "error") throw new Error("expected error item");
  assert.equal(errorItem.failure.message, "fixture provider failure");
  assert.equal(errorItem.failure.code, "FixtureProviderError");
  assert.equal(errorItem.failure.class, "provider_error");
}
