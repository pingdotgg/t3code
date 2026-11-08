import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  field,
  projectionFor,
} from "../shared.ts";
import { KIRO_COMPACTION_MARKER } from "./input.ts";

function promptText(frame: unknown): string {
  const prompt = field(field(frame, "params"), "prompt");
  return Array.isArray(prompt) ? prompt.map((block) => String(field(block, "text"))).join("") : "";
}

export function assertKiroCompactionOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const outbound = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" ? [entry.frame] : [],
  );
  const prompts = outbound.filter((frame) => field(frame, "method") === "session/prompt");
  assert.lengthOf(prompts, 2, "/compact must not be sent as a prompt");
  assert.lengthOf(
    outbound.filter((frame) => field(frame, "method") === "_kiro/session/compact"),
    1,
  );
  // Compaction drops T3's instructions from Kiro's context, so the next prompt carries them again.
  assert.deepEqual(
    prompts.map((frame) => promptText(frame).startsWith("<t3_code_instructions>")),
    [true, true],
  );

  assertBaseProjection({
    result,
    transcript,
    runCount: 3,
    runStatuses: ["completed", "completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assert.deepEqual(
    projection.turnItems
      .filter((item) => item.type === "compaction")
      .map((item) => [item.runId, item.status, item.title]),
    [[projection.runs[1]?.id ?? null, "completed", "Context compacted"]],
  );
  const recall = projection.turnItems
    .filter((item) => item.type === "assistant_message" && item.runId === projection.runs[2]?.id)
    .map((item) => (item.type === "assistant_message" ? item.text : ""))
    .join("");
  assert.include(recall, KIRO_COMPACTION_MARKER);
}
