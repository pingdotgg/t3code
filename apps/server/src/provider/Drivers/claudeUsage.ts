import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
  tokenCount,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";

// Claude Code uses this model for local placeholders that never reached the API.
export const CLAUDE_SYNTHETIC_MODEL = "<synthetic>";

/**
 * Claude Code repeats a message's `dedupeKey` for each assistant content block.
 * Subagent blocks can progress from stream-start to final usage, so callers
 * must count each key once using the maximum of each token channel.
 */
export function parseClaudeLine(line: string): readonly UsageRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  return parseClaudeRecord(parsed);
}

function parseClaudeRecord(parsed: unknown): readonly UsageRecord[] {
  if (typeof parsed !== "object" || parsed === null) return [];

  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "assistant") return [];

  const message = record["message"];
  if (typeof message !== "object" || message === null) return [];
  const messageRecord = message as Record<string, unknown>;

  const usage = messageRecord["usage"];
  if (typeof usage !== "object" || usage === null) return [];
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return [];

  const model = typeof messageRecord["model"] === "string" ? messageRecord["model"] : "";
  if (model.length === 0 || model === CLAUDE_SYNTHETIC_MODEL) return [];

  const messageId = typeof messageRecord["id"] === "string" ? messageRecord["id"] : null;
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : null;
  const dedupeKey =
    messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`;

  const cost = record["costUSD"];
  const iterations: readonly unknown[] = Array.isArray(usageRecord["iterations"])
    ? usageRecord["iterations"]
    : [];
  // After a server-side fallback the top-level usage can name the declined model and merge
  // attempts; the serving `fallback_message` iteration holds what its own model billed.
  const servingIndex = iterations.findLastIndex(
    (iteration) => iterationRecord(iteration)?.["type"] === "fallback_message",
  );
  const serving = iterationRecord(iterations[servingIndex]);

  const executor: UsageRecord = {
    provider: "claude",
    timestampMs,
    model: (serving === null ? null : iterationModel(serving)) ?? model,
    sessionId: typeof record["sessionId"] === "string" ? record["sessionId"] : "",
    totals: usageTotals(serving ?? usageRecord),
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    speed: usageRecord["speed"] === "fast" ? "fast" : "standard",
    dedupeKey,
  };

  // Advisor calls and declined attempts bill at their own model's rates. Anthropic bills a
  // declined attempt that produced output; most declines before any output are free.
  const records = [executor];
  for (const [index, iteration] of iterations.entries()) {
    const entry = iterationRecord(iteration);
    if (entry === null) continue;
    const kind =
      entry["type"] === "advisor_message"
        ? "advisor"
        : entry["type"] === "message" &&
            index < servingIndex &&
            tokenCount(entry["output_tokens"]) > 0
          ? "attempt"
          : null;
    const entryModel = iterationModel(entry);
    if (kind === null || entryModel === null) continue;

    records.push({
      provider: "claude",
      timestampMs,
      model: entryModel,
      sessionId: executor.sessionId,
      totals: usageTotals(entry),
      reportedCostUsd: null,
      speed: executor.speed,
      dedupeKey: dedupeKey === null ? null : `${dedupeKey}:${kind}:${index}`,
    });
  }
  return records;
}

function iterationRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function iterationModel(iteration: Record<string, unknown>): string | null {
  const model = iteration["model"];
  return typeof model === "string" && model.length > 0 && model !== CLAUDE_SYNTHETIC_MODEL
    ? model
    : null;
}

function usageTotals(usage: Record<string, unknown>): UsageRecord["totals"] {
  return {
    uncachedInputTokens: tokenCount(usage["input_tokens"]),
    cachedInputTokens: tokenCount(usage["cache_read_input_tokens"]),
    cacheCreationTokens: tokenCount(usage["cache_creation_input_tokens"]),
    outputTokens: tokenCount(usage["output_tokens"]),
    // Anthropic folds thinking tokens into output and does not break them out.
    reasoningTokens: 0,
  };
}

export const claudeUsageFormat: TranscriptUsageFormat<void> = {
  selectFields: {
    type: true,
    timestamp: true,
    requestId: true,
    sessionId: true,
    costUSD: true,
    message: { id: true, model: true, usage: true },
  },
  usageMarkers: ['"usage"'],
  parseLine: (line) => parseClaudeLine(line),
  parseProjected: (projected) => parseClaudeRecord(projected),
};

export const claudeUsageReader: ProviderUsageReader<ClaudeSettings, Path.Path> = {
  kind: "transcripts",
  provider: "claude",
  format: claudeUsageFormat,
  directories: Effect.fn("claudeUsageReader.directories")(function* ({ config, environment }) {
    if (config === undefined) return [];
    const path = yield* Path.Path;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const configured = config.homePath.trim();
    const home = configured
      ? expandHomePath(configured, homeDirectory)
      : environment.CLAUDE_CONFIG_DIR?.trim() || path.join(homeDirectory, ".claude");
    return [{ dir: path.resolve(home, "projects") }];
  }),
};
