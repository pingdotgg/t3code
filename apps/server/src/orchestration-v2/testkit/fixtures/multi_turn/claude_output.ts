import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertMultiTurnOutput } from "./codex_output.ts";
import { projectionFor } from "../shared.ts";

function isReplayFrameWithType(
  frame: unknown,
  type: string,
): frame is { readonly type: string; readonly options?: Record<string, unknown> } {
  return (
    typeof frame === "object" &&
    frame !== null &&
    "type" in frame &&
    (frame as { readonly type?: unknown }).type === type
  );
}

export function assertMultiTurnClaudeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertMultiTurnOutput(result, transcript);

  const projection = projectionFor(result, transcript.scenario);
  assert.lengthOf(projection.providerThreads, 1);
  const providerThread = projection.providerThreads[0];
  assert.isDefined(providerThread);
  assert.isNotNull(providerThread.nativeThreadRef);
  assert.deepEqual(
    projection.runs.map((run) => run.providerThreadId),
    projection.runs.map(() => providerThread.id),
  );

  const outboundFrames = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" ? [entry.frame] : [],
  );
  const queryOpenFrames = outboundFrames.filter((frame) =>
    isReplayFrameWithType(frame, "query.open"),
  );
  const promptOfferFrames = outboundFrames.filter((frame) =>
    isReplayFrameWithType(frame, "prompt.offer"),
  );

  assert.lengthOf(promptOfferFrames, 2);
  if (transcript.scenario === "multi_turn_restart") {
    assert.lengthOf(queryOpenFrames, 2);
    assert.isString(queryOpenFrames[1]?.options?.resume);
  } else {
    assert.lengthOf(queryOpenFrames, 1);
  }
}
