import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
// This scanner needs a tiny fire-and-forget trigger of a sibling systemd unit,
// which Effect/process does not model for plugins; a direct exec keeps it simple.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import { UsageReadError } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { AcpRegistrySettings } from "../settings.ts";

/**
 * Mistral Vibe keeps no token history of its own, so per-turn usage is exported from
 * T3's provider-turn projection into JSONL files, one line per turn, which this reads.
 */
const Entry = Schema.Struct({
  type: Schema.Literal("mistral_vibe_usage"),
  sessionId: Schema.NonEmptyString,
  turn: Schema.Number,
  timestamp: Schema.String,
  model: Schema.NonEmptyString,
  inputTokens: Schema.optional(Schema.Unknown),
  cachedInputTokens: Schema.optional(Schema.Unknown),
  cacheCreationTokens: Schema.optional(Schema.Unknown),
  outputTokens: Schema.optional(Schema.Unknown),
  reasoningTokens: Schema.optional(Schema.Unknown),
});
const decodeEntry = Schema.decodeUnknownOption(Entry);

function parseRecord(parsed: unknown): readonly UsageRecord[] {
  const decoded = decodeEntry(parsed);
  if (Option.isNone(decoded)) return [];
  const entry = decoded.value;
  const timestampMs = parseTimestampMs(entry.timestamp);
  if (timestampMs === null) return [];
  const inputTokens = tokenCount(entry.inputTokens);
  const cachedInputTokens = Math.min(inputTokens, tokenCount(entry.cachedInputTokens));
  const outputTokens = tokenCount(entry.outputTokens);
  const totals = {
    // TurnTokenUsage input includes cache reads; usage totals keep them disjoint.
    uncachedInputTokens: inputTokens - cachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens: tokenCount(entry.cacheCreationTokens),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(entry.reasoningTokens)),
  };
  if (totalTokens(totals) === 0) return [];
  return [
    {
      provider: "mistral-vibe",
      timestampMs,
      model: entry.model,
      sessionId: entry.sessionId,
      totals,
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: JSON.stringify(["mistral-vibe", entry.sessionId, entry.turn]),
    },
  ];
}

export const mistralVibeUsageFormat: TranscriptUsageFormat<unknown> = {
  selectFields: {
    type: true,
    sessionId: true,
    turn: true,
    timestamp: true,
    model: true,
    inputTokens: true,
    cachedInputTokens: true,
    cacheCreationTokens: true,
    outputTokens: true,
    reasoningTokens: true,
  },
  usageMarkers: ['"mistral_vibe_usage"'],
  parseLine: (line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseRecord(parsed);
  },
  parseProjected: (projected) => parseRecord(projected),
};

/**
 * Trigger a fresh export and wait for it, so a Usage refresh always reads
 * current data instead of whatever the last timer run produced. `--wait`
 * blocks until the oneshot unit's ExecStart completes. Best-effort: a
 * missing or hung exporter never blocks a scan for more than a few seconds.
 */
const triggerExport = Effect.fn("mistralVibeUsage.triggerExport")(function* () {
  yield* Effect.tryPromise<void, UsageReadError>({
    try: () =>
      new Promise<void>((resolve, reject) =>
        NodeChildProcess.execFile(
          "systemctl",
          ["--user", "start", "--wait", "mistral-vibe-usage-export.service"],
          (error) =>
            error
              ? reject(
                  new UsageReadError({
                    reason: "scanFailed",
                    detail: "Mistral Vibe usage exporter could not start",
                    cause: error,
                  }),
                )
              : resolve(),
        ),
      ),
    catch: (cause) =>
      new UsageReadError({
        reason: "scanFailed",
        detail: "Mistral Vibe usage exporter could not start",
        cause,
      }),
  });
});

export const mistralVibeUsageReader: ProviderUsageReader<AcpRegistrySettings, Path.Path> = {
  kind: "transcripts",
  provider: "mistral-vibe",
  format: mistralVibeUsageFormat,
  directories: Effect.fn("mistralVibeUsageReader.directories")(function* ({ environment }) {
    // Refresh-triggered export; a failed or missing exporter is fine (the
    // scan just reads the last exported files) and must not fail the scan.
    yield* Effect.ignoreCause(triggerExport());
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const configured = environment["MISTRAL_VIBE_USAGE_DIR"]?.trim();
    return [
      {
        dir: path.resolve(
          expandHomePath(
            configured || path.join(home, ".local", "share", "mistral-vibe-usage"),
            home,
          ),
        ),
      },
    ];
  }),
};
