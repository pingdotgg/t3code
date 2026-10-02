import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";
import { PI_COMPACTION_MARKER } from "./input.ts";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * `/compact` reaches Pi as the RPC `compact` command, never as a prompt, with
 * any trailing text as custom instructions. A compaction Pi refuses still
 * settles its run and shows a failed compaction row; a successful one carries
 * Pi's own summary and token counts, and the next turn recalls the marker.
 */
export function assertPiCompactionOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const outbound = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" ? [entry.frame] : [],
  );
  assert.isFalse(
    outbound.some(
      (frame) =>
        field(frame, "type") === "prompt" && String(field(frame, "message")).startsWith("/compact"),
    ),
    "/compact must not be sent as a prompt",
  );
  assert.deepEqual(
    outbound.filter((frame) => field(frame, "type") === "compact"),
    [
      { type: "compact", customInstructions: `keep the opaque marker ${PI_COMPACTION_MARKER}` },
      { type: "compact" },
    ],
  );
  const compactionEnds = transcript.entries
    .flatMap((entry) => (entry.type === "emit_inbound" ? [entry.frame] : []))
    .filter((frame) => field(frame, "type") === "compaction_end");
  assert.lengthOf(compactionEnds, 2);
  const [refused, compacted] = compactionEnds;
  // Pi omits `result` on failure rather than sending null.
  assert.isFalse(typeof refused === "object" && refused !== null && "result" in refused);
  const compactionResult = field(compacted, "result");
  assert.isDefined(compactionResult, "the second compaction must succeed");

  assertBaseProjection({
    result,
    transcript,
    runCount: 6,
    runStatuses: ["completed", "completed", "completed", "completed", "completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  const compactionRuns = [projection.runs[1], projection.runs[4]];
  const compactions = projection.turnItems.filter((item) => item.type === "compaction");
  assert.deepEqual(
    compactions.map((item) => [item.runId, item.status, item.title]),
    [
      [compactionRuns[0]?.id ?? null, "failed", "Context compaction failed"],
      [compactionRuns[1]?.id ?? null, "completed", "Context compacted"],
    ],
  );
  assert.equal(compactions[0]?.summary, field(refused, "errorMessage"));
  assert.equal(compactions[1]?.summary, field(compactionResult, "summary"));
  assert.equal(compactions[1]?.beforeTokenCount, field(compactionResult, "tokensBefore"));
  assert.equal(compactions[1]?.afterTokenCount, field(compactionResult, "estimatedTokensAfter"));
  assert.isFalse(
    projection.turnItems.some(
      (item) =>
        compactionRuns.some((run) => run?.id === item.runId) && item.type === "assistant_message",
    ),
    "compaction must not run a model turn",
  );
  // Right after compacting, Pi reports context usage as unknown (tokens: null);
  // the meter keeps Pi's own post-compaction estimate instead of going blank.
  const compactionTurn = projection.providerTurns.find(
    (turn) => turn.runAttemptId === compactionRuns[1]?.activeAttemptId,
  );
  assert.equal(
    compactionTurn?.tokenUsage?.usedTokens,
    field(compactionResult, "estimatedTokensAfter"),
  );

  const recall = projection.turnItems.findLast((item) => item.type === "assistant_message");
  assert.include(recall?.text, PI_COMPACTION_MARKER);
}
