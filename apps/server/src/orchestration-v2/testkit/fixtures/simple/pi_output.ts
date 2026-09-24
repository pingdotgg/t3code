import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { projectionFor } from "../shared.ts";
import { assertSimpleOutput } from "./codex_output.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/** Data of the last recorded successful response to `command`. */
function lastPiResponseData(transcript: ProviderReplayTranscript, command: string): unknown {
  const frame = transcript.entries
    .flatMap((entry) => (entry.type === "emit_inbound" ? [entry.frame] : []))
    .findLast(
      (candidate) =>
        field(candidate, "type") === "response" && field(candidate, "command") === command,
    );
  assert.isDefined(frame, `transcript must record a ${command} response`);
  return field(frame, "data");
}

/**
 * Pi-specific additions to the shared simple contract: the streamed thinking
 * block becomes a reasoning item, the settled turn carries the context usage
 * from `get_session_stats`, and the turn's native ref is the session-tree id
 * of its user message (the point rollback and fork re-root at).
 */
export function assertPiSimpleOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertSimpleOutput(result, transcript);
  const projection = projectionFor(result, transcript.scenario);

  const reasoning = projection.turnItems.find((item) => item.type === "reasoning");
  assert.isDefined(reasoning, "Pi thinking deltas must project a reasoning item");
  assert.include(reasoning.text, "fixture simple ok");

  const stats = lastPiResponseData(transcript, "get_session_stats");
  const contextUsage = field(stats, "contextUsage");
  const tokens = field(stats, "tokens");
  const [turn] = projection.providerTurns;
  assert.equal(turn?.status, "completed");
  const { updatedAt: _updatedAt, ...tokenUsage } = turn?.tokenUsage ?? { updatedAt: "" };
  assert.deepEqual(tokenUsage, {
    usedTokens: field(contextUsage, "tokens"),
    maxTokens: field(contextUsage, "contextWindow"),
    inputTokens: field(tokens, "input"),
    cachedInputTokens: field(tokens, "cacheRead"),
    outputTokens: field(tokens, "output"),
  });

  const entries = field(lastPiResponseData(transcript, "get_entries"), "entries");
  const userEntryId = (Array.isArray(entries) ? entries : [])
    .filter(
      (entry) =>
        field(entry, "type") === "message" && field(field(entry, "message"), "role") === "user",
    )
    .map((entry) => field(entry, "id"))
    .at(0);
  assert.isString(userEntryId);
  assert.equal(turn?.nativeTurnRef?.nativeId, userEntryId);
  assert.equal(turn?.nativeTurnRef?.strength, "strong");
}
