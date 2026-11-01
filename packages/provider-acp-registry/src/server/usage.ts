import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
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

/** dsh rewrites its compressed JSONL session snapshot as the session grows. */

const DshScanState = Schema.Struct({
  sessionId: Schema.mutableKey(Schema.String),
  model: Schema.mutableKey(Schema.String),
});

const Usage = Schema.Struct({
  inputTokens: Schema.optional(Schema.Unknown),
  outputTokens: Schema.optional(Schema.Unknown),
  cacheReadTokens: Schema.optional(Schema.Unknown),
  cacheWriteTokens: Schema.optional(Schema.Unknown),
  reasoningTokens: Schema.optional(Schema.Unknown),
  thoughtTokens: Schema.optional(Schema.Unknown),
});

const Model = {
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
};

const Entry = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session"), id: Schema.optional(Schema.String) }),
  Schema.Struct({
    type: Schema.Literal("request/context"),
    data: Schema.Struct(Model),
  }),
  Schema.Struct({
    type: Schema.Literal("assistant/message"),
    seq: Schema.optional(Schema.Number),
    time: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
    data: Schema.Struct({
      message: Schema.optional(Schema.Struct({ source: Schema.optional(Schema.Struct(Model)) })),
      usage: Schema.optional(Usage),
    }),
  }),
]);
const decodeEntry = Schema.decodeUnknownOption(Entry);

function timestampMs(value: number | string | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  return parseTimestampMs(value);
}

function modelName(provider: string | undefined, model: string | undefined): string {
  if (model === undefined || model.length === 0) return "";
  return provider === undefined || provider.length === 0 ? model : `${provider}/${model}`;
}

function parseRecord(parsed: unknown, state: typeof DshScanState.Type): readonly UsageRecord[] {
  const decoded = decodeEntry(parsed);
  if (Option.isNone(decoded)) return [];
  const entry = decoded.value;
  if (entry.type === "session") {
    if (entry.id !== undefined && entry.id.length > 0) state.sessionId = entry.id;
    return [];
  }
  if (entry.type === "request/context") {
    const model = modelName(entry.data.provider, entry.data.model);
    if (model.length > 0) state.model = model;
    return [];
  }
  const usage = entry.data.usage;
  if (usage === undefined) return [];
  const timestamp = timestampMs(entry.time);
  if (timestamp === null) return [];
  const source = entry.data.message?.source;
  const model = modelName(source?.provider, source?.model) || state.model;
  const outputTokens = tokenCount(usage.outputTokens);
  const totals = {
    // dsh's input counter excludes cache reads; the bridge adds them separately.
    uncachedInputTokens: tokenCount(usage.inputTokens),
    cachedInputTokens: tokenCount(usage.cacheReadTokens),
    cacheCreationTokens: tokenCount(usage.cacheWriteTokens),
    outputTokens,
    reasoningTokens: Math.min(
      outputTokens,
      tokenCount(usage.reasoningTokens ?? usage.thoughtTokens),
    ),
  };
  if (totalTokens(totals) === 0) return [];
  return [
    {
      provider: "dsh",
      timestampMs: timestamp,
      model: model.length > 0 ? model : "unknown",
      ...(source?.model === undefined ? {} : { rateModel: source.model }),
      sessionId: state.sessionId,
      totals,
      // dsh does not record a cost; the Usage page prices these tokens with its rate table.
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: JSON.stringify(["dsh", state.sessionId, entry.seq ?? timestamp]),
    },
  ];
}

export const dshUsageFormat: TranscriptUsageFormat<typeof DshScanState.Type> = {
  selectFields: {
    type: true,
    id: true,
    seq: true,
    time: true,
    data: {
      provider: true,
      model: true,
      usage: true,
      message: { source: { provider: true, model: true } },
    },
  },
  usageMarkers: ['"usage"', '"session"', '"request/context"'],
  parseLine: (line, state) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseRecord(parsed, state);
  },
  parseProjected: parseRecord,
  state: { initial: () => ({ sessionId: "", model: "" }), schema: DshScanState },
};

/** The local ACP command this reader recognizes as DeepSeek Harness. */
export function isDshCommand(commandPath: string): boolean {
  const base = commandPath.trim().split(/[\\/]/u).pop()?.toLowerCase() ?? "";
  const stem = base.replace(/\.(?:exe|cmd|bat|js|mjs|cjs)$/u, "");
  return stem === "dsh" || stem === "dsh-acp";
}

export function isDshInstance(config: AcpRegistrySettings | undefined): boolean {
  return config !== undefined && config.source === "local" && isDshCommand(config.commandPath);
}

/** Where dsh keeps its per-project, per-session logs; matches dsh's own `DSH_HOME` lookup. */
export function resolveDshSessionsDir(
  environment: NodeJS.ProcessEnv,
  home: string,
  path: Path.Path,
): string {
  const configured = environment.DSH_HOME?.trim();
  const dshHome = configured ? expandHomePath(configured, home) : path.join(home, ".dsh");
  return path.resolve(dshHome, "sessions");
}

export const dshUsageReader: ProviderUsageReader<AcpRegistrySettings, Path.Path> = {
  kind: "transcripts",
  provider: "dsh",
  format: dshUsageFormat,
  directories: Effect.fn("dshUsageReader.directories")(function* ({ config, environment }) {
    if (!isDshInstance(config)) return [];
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    return [{ dir: resolveDshSessionsDir(environment, home, path) }];
  }),
};
