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
 * Pi reports usage only through `get_session_stats`, read once per settled
 * turn: each completed provider turn carries the stats response recorded for
 * it, in order, not the last live streaming total.
 */
export function assertPiSettledTokenUsage(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const stats = transcript.entries.flatMap((entry) =>
    entry.type === "emit_inbound" &&
    field(entry.frame, "type") === "response" &&
    field(entry.frame, "command") === "get_session_stats"
      ? [field(entry.frame, "data")]
      : [],
  );
  const turns = projectionFor(result, transcript.scenario).providerTurns;
  assert.lengthOf(turns, stats.length);
  for (const [index, turn] of turns.entries()) {
    const contextUsage = field(stats[index], "contextUsage");
    const tokens = field(stats[index], "tokens");
    const { updatedAt: _updatedAt, ...tokenUsage } = turn.tokenUsage ?? { updatedAt: "" };
    assert.deepEqual(tokenUsage, {
      usedTokens: field(contextUsage, "tokens"),
      maxTokens: field(contextUsage, "contextWindow"),
      inputTokens: field(tokens, "input"),
      cachedInputTokens: field(tokens, "cacheRead"),
      outputTokens: field(tokens, "output"),
    });
  }
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

  assertPiSettledTokenUsage(result, transcript);
  const [turn] = projection.providerTurns;

  // Pi attaches cumulative usage to every streaming update, zeros until the
  // provider reports. The running turn moves the meter once per new total.
  const streamedTotals = transcript.entries.flatMap((entry) =>
    entry.type === "emit_inbound" && field(entry.frame, "type") === "message_update"
      ? [field(field(entry.frame, "usage"), "totalTokens")]
      : [],
  );
  const liveUsage = result.domainEvents.flatMap((event) =>
    event.type === "provider-turn.updated" &&
    event.payload.status === "running" &&
    event.payload.tokenUsage !== undefined
      ? [event.payload.tokenUsage.usedTokens]
      : [],
  );
  assert.deepEqual(liveUsage, [...new Set(streamedTotals.filter((total) => total !== 0))]);

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
