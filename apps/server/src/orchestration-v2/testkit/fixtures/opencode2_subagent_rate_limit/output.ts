import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

export function assertOpenCode2SubagentRateLimitOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  const item = projection.turnItems.find((candidate) => candidate.type === "subagent");
  assert.strictEqual(item?.type, "subagent");
  if (item?.type !== "subagent") throw new Error("OpenCode 2 subagent item is missing");
  assert.strictEqual(item.status, "failed");
  assert.match(item.result ?? "", /HTTP 429/);
  assert.isNotNull(item.childThreadId);
  const child = result.projections.get(item.childThreadId!);
  assert.isDefined(child);
  const failure = child!.turnItems.find((candidate) => candidate.type === "error");
  assert.strictEqual(failure?.type, "error");
  if (failure?.type !== "error") throw new Error("OpenCode 2 child failure item is missing");
  assert.strictEqual(failure.status, "failed");
  assert.strictEqual(failure.failure.code, "provider.rate-limit");
  assert.strictEqual(failure.failure.retryable, true);
  assert.strictEqual(failure.retry?.attempt, 5);
  assertAssistantTextIncludes(projection, "PARENT_AFTER_429");
  assert.strictEqual(projection.subagents[0]?.status, "failed");
}
