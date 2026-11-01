import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";
import { ACP_REGISTRY_COMPACTION_SUMMARY } from "./input.ts";

/**
 * A bare `/compact` reaches the registry agent as a `session/prompt` (the
 * transcript's `compact.prompt` expectation) and settles as one completed
 * compaction row carrying the agent's own summary, not a duplicate T3 marker.
 */
export function assertAcpRegistryCompactionOutput(
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
  const compactionRun = projection.runs[1];
  assert.deepEqual(
    projection.turnItems
      .filter((item) => item.type === "compaction")
      .map((item) => [item.runId, item.status, item.summary]),
    [[compactionRun?.id ?? null, "completed", ACP_REGISTRY_COMPACTION_SUMMARY]],
  );
}

/**
 * An agent without `/compact` answers it like any prompt. Its reply is the
 * result; T3 must not add a "Context compacted" row the agent never reported.
 */
export function assertAcpRegistryUnsupportedCompactionOutput(
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
  const compactionRun = projection.runs[1];
  assert.deepEqual(
    projection.turnItems.filter((item) => item.type === "compaction"),
    [],
  );
  assert.deepEqual(
    projection.turnItems.flatMap((item) =>
      item.runId === compactionRun?.id && item.type === "assistant_message" ? [item.text] : [],
    ),
    ["Unknown command: /compact"],
  );
}

/**
 * Only the agent's own `completed` report means compaction happened. A turn
 * that ends while the agent's compaction is still in progress settles the row
 * as interrupted and keeps the reported context usage.
 */
export function assertAcpRegistryUnfinishedCompactionOutput(
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
  const compactionRun = projection.runs[1];
  assert.deepEqual(
    projection.turnItems
      .filter((item) => item.type === "compaction")
      .map((item) => [item.runId, item.status]),
    [[compactionRun?.id ?? null, "interrupted"]],
  );
  assert.deepEqual(
    projection.providerThreads.map((thread) => thread.contextUsage?.usedTokens),
    [420],
  );
}
