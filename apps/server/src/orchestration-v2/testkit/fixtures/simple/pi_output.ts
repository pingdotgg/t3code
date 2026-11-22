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
 * Settled Pi usage takes the context size from each turn's get_session_stats response and the
 * input breakdown from the turn's last streamed message usage, since stats tokens are session totals.
 */
export function assertPiSettledTokenUsage(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const expected: Array<Record<string, unknown>> = [];
  let messageUsage: unknown;
  for (const entry of transcript.entries) {
    if (entry.type !== "emit_inbound") continue;
    const usage = field(entry.frame, "usage");
    if (field(entry.frame, "type") === "message_update" && field(usage, "totalTokens") !== 0) {
      messageUsage = usage;
    }
    if (
      field(entry.frame, "type") === "response" &&
      field(entry.frame, "command") === "get_session_stats"
    ) {
      const contextUsage = field(field(entry.frame, "data"), "contextUsage");
      const count = (key: string) => Number(field(messageUsage, key));
      expected.push({
        usedTokens: field(contextUsage, "tokens"),
        maxTokens: field(contextUsage, "contextWindow"),
        inputTokens: count("input") + count("cacheRead") + count("cacheWrite"),
        cachedInputTokens: count("cacheRead"),
        outputTokens: count("output"),
      });
    }
  }
  const turns = projectionFor(result, transcript.scenario).providerTurns;
  assert.deepEqual(
    turns.map((turn) => {
      const { updatedAt: _updatedAt, ...tokenUsage } = turn.tokenUsage ?? { updatedAt: "" };
      return tokenUsage;
    }),
    expected,
  );
}

export function assertPiSimpleOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertSimpleOutput(result, transcript);
  const projection = projectionFor(result, transcript.scenario);

  const recordedThinking = transcript.entries.flatMap((entry) => {
    const update = field(
      entry.type === "emit_inbound" ? entry.frame : undefined,
      "assistantMessageEvent",
    );
    return field(update, "type") === "thinking_end" ? [field(update, "content")] : [];
  });
  assert.lengthOf(recordedThinking, 1, "the recording must stream one thinking block");
  assert.deepEqual(
    projection.turnItems.flatMap((item) => (item.type === "reasoning" ? [item.text] : [])),
    recordedThinking,
    "Pi thinking deltas must project as one reasoning item with the recorded text",
  );

  assertPiSettledTokenUsage(result, transcript);
  const [turn] = projection.providerTurns;

  // Pi streams cumulative usage, initially zeros until the provider reports.
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
