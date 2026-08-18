// @effect-diagnostics nodeBuiltinImport:off
/**
 * Read-only access to OpenCode's local usage database.
 *
 * OpenCode keeps exact usage on assistant messages. Current releases use the
 * `session_message` table while older releases use `message`. Installations
 * migrating between them may contain both. The current representation owns a
 * session from its first projected assistant onward; older legacy rows remain
 * useful before that boundary.
 *
 * @module usageOpenCodeReader
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";

const OpenCodeUsageRow = Schema.Struct({
  source: Schema.Union([Schema.Literal("current"), Schema.Literal("legacy")]),
  id: Schema.String,
  sessionId: Schema.String,
  createdAtMs: Schema.Number,
  timestampMs: Schema.NullOr(Schema.Number),
  providerId: Schema.NullOr(Schema.String),
  modelId: Schema.NullOr(Schema.String),
  costUsd: Schema.NullOr(Schema.Number),
  inputTokens: Schema.NullOr(Schema.Number),
  outputTokens: Schema.NullOr(Schema.Number),
  reasoningTokens: Schema.NullOr(Schema.Number),
  cacheReadTokens: Schema.NullOr(Schema.Number),
  cacheWriteTokens: Schema.NullOr(Schema.Number),
});
const decodeOpenCodeUsageRow = Schema.decodeUnknownOption(OpenCodeUsageRow);
const decodeOpenCodeUsageRows = Schema.decodeUnknownOption(Schema.Array(OpenCodeUsageRow));

const OpenCodeMigrationBoundary = Schema.Struct({
  sessionId: Schema.String,
  timestampMs: Schema.Number,
});
const decodeOpenCodeMigrationBoundaries = Schema.decodeUnknownSync(
  Schema.Array(OpenCodeMigrationBoundary),
);

export type OpenCodeUsageSchema = "current" | "legacy" | "mixed";

export interface OpenCodeUsageReadSuccess {
  readonly status: "ok";
  readonly schema: OpenCodeUsageSchema;
  readonly records: readonly UsageRecord[];
  readonly malformedRecords: number;
}

export interface OpenCodeUsageReadFailure {
  readonly status: "failed";
  readonly message: string;
}

export type OpenCodeUsageReadResult = OpenCodeUsageReadSuccess | OpenCodeUsageReadFailure;

/** Mirrors OpenCode's `xdg-basedir` data path without starting the CLI. */
export function resolveOpenCodeDataDir(
  environment: NodeJS.ProcessEnv = process.env,
  homePath: string = NodeOS.homedir(),
): string {
  const configured = environment.XDG_DATA_HOME?.trim();
  const dataHome =
    configured && configured.length > 0 ? configured : NodePath.join(homePath, ".local", "share");
  return NodePath.join(dataHome, "opencode");
}

function nonNegativeInt(value: number | null): number {
  return value !== null && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function tableExists(database: NodeSqlite.DatabaseSync, table: string): boolean {
  return (
    database
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(table) !== undefined
  );
}

function tableHasRows(database: NodeSqlite.DatabaseSync, table: string): boolean {
  return database.prepare(`SELECT 1 AS present FROM ${table} LIMIT 1`).get() !== undefined;
}

const CURRENT_USAGE_QUERY = `
  SELECT
    'current' AS source,
    id,
    session_id AS sessionId,
    time_created AS createdAtMs,
    COALESCE(json_extract(data, '$.time.completed'), time_created) AS timestampMs,
    json_extract(data, '$.model.providerID') AS providerId,
    json_extract(data, '$.model.id') AS modelId,
    json_extract(data, '$.cost') AS costUsd,
    json_extract(data, '$.tokens.input') AS inputTokens,
    json_extract(data, '$.tokens.output') AS outputTokens,
    json_extract(data, '$.tokens.reasoning') AS reasoningTokens,
    json_extract(data, '$.tokens.cache.read') AS cacheReadTokens,
    json_extract(data, '$.tokens.cache.write') AS cacheWriteTokens
  FROM session_message
  WHERE type = 'assistant' AND time_created >= ?
`;

const LEGACY_USAGE_QUERY = `
  SELECT
    'legacy' AS source,
    id,
    session_id AS sessionId,
    time_created AS createdAtMs,
    COALESCE(json_extract(data, '$.time.completed'), time_created) AS timestampMs,
    json_extract(data, '$.providerID') AS providerId,
    json_extract(data, '$.modelID') AS modelId,
    json_extract(data, '$.cost') AS costUsd,
    json_extract(data, '$.tokens.input') AS inputTokens,
    json_extract(data, '$.tokens.output') AS outputTokens,
    json_extract(data, '$.tokens.reasoning') AS reasoningTokens,
    json_extract(data, '$.tokens.cache.read') AS cacheReadTokens,
    json_extract(data, '$.tokens.cache.write') AS cacheWriteTokens
  FROM message
  WHERE json_extract(data, '$.role') = 'assistant' AND time_created >= ?
`;

const CURRENT_MIGRATION_BOUNDARIES_QUERY = `
  SELECT
    session_id AS sessionId,
    MIN(time_created) AS timestampMs
  FROM session_message
  WHERE type = 'assistant'
  GROUP BY session_id
`;

interface OpenCodeUsageCacheEntry {
  readonly databaseState: string;
  readonly resultsBySinceMs: Map<number, OpenCodeUsageReadSuccess>;
}

const MAX_CACHED_WINDOWS = 8;
const usageCache = new Map<string, OpenCodeUsageCacheEntry>();

function fileState(path: string, required: boolean): string | null {
  try {
    const stat = NodeFS.statSync(path, { bigint: true });
    return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(":");
  } catch {
    return required ? null : "missing";
  }
}

/** Includes SQLite sidecars so uncheckpointed WAL writes invalidate the cache. */
function databaseState(databasePath: string): string | null {
  const main = fileState(databasePath, true);
  if (main === null) return null;
  return [
    main,
    fileState(`${databasePath}-wal`, false),
    fileState(`${databasePath}-journal`, false),
  ].join("|");
}

function usageIdentity(value: typeof OpenCodeUsageRow.Type): string {
  // Forks copy these provider-call fields and timestamps verbatim while
  // replacing the message and session IDs. A genuine post-fork call receives
  // fresh timestamps and therefore remains distinct.
  return JSON.stringify([
    value.createdAtMs,
    value.timestampMs,
    value.providerId,
    value.modelId,
    value.costUsd,
    value.inputTokens,
    value.outputTokens,
    value.reasoningTokens,
    value.cacheReadTokens,
    value.cacheWriteTokens,
  ]);
}

/**
 * Reads message-level OpenCode usage without materialising message content.
 *
 * `sinceMs` is only a query prefilter. Exact daily/hourly bounds are still
 * applied by {@link UsageAggregator}, just as they are for transcript files.
 */
function readOpenCodeUsageRecordsUncached(
  databasePath: string,
  sinceMs: number,
): OpenCodeUsageReadResult {
  let database: NodeSqlite.DatabaseSync | null = null;
  try {
    database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });

    const hasCurrent = tableExists(database, "session_message");
    const hasLegacy = tableExists(database, "message");
    const hasCurrentRows = hasCurrent && tableHasRows(database, "session_message");
    const schema: OpenCodeUsageSchema | null =
      hasCurrentRows && hasLegacy
        ? "mixed"
        : hasCurrentRows
          ? "current"
          : hasLegacy
            ? "legacy"
            : hasCurrent
              ? "current"
              : null;
    if (schema === null) {
      return {
        status: "failed",
        message: "The OpenCode database uses an unsupported session schema.",
      };
    }

    const rows =
      schema === "current"
        ? database.prepare(CURRENT_USAGE_QUERY).all(sinceMs)
        : schema === "legacy"
          ? database.prepare(LEGACY_USAGE_QUERY).all(sinceMs)
          : [
              ...database.prepare(CURRENT_USAGE_QUERY).all(sinceMs),
              ...database.prepare(LEGACY_USAGE_QUERY).all(sinceMs),
            ];
    const migrationBoundaries =
      schema === "mixed"
        ? new Map(
            decodeOpenCodeMigrationBoundaries(
              database.prepare(CURRENT_MIGRATION_BOUNDARIES_QUERY).all(),
            ).map((value) => [value.sessionId, value.timestampMs] as const),
          )
        : new Map<string, number>();
    const decodedRows = decodeOpenCodeUsageRows(rows);
    const candidates = Option.isSome(decodedRows)
      ? decodedRows.value.map((value) => Option.some(value))
      : rows.map((row) => decodeOpenCodeUsageRow(row));
    const validCandidates: Array<{
      readonly source: "current" | "legacy";
      readonly identity: string;
      readonly record: UsageRecord;
      readonly coveredByCurrentMigration: boolean;
    }> = [];
    let malformedRecords = 0;

    for (const decoded of candidates) {
      if (Option.isNone(decoded)) {
        malformedRecords += 1;
        continue;
      }

      const value = decoded.value;
      const providerId = value.providerId?.trim() ?? "";
      const modelId = value.modelId?.trim() ?? "";
      if (
        value.timestampMs === null ||
        !Number.isFinite(value.timestampMs) ||
        providerId.length === 0 ||
        modelId.length === 0
      ) {
        malformedRecords += 1;
        continue;
      }

      const reasoningTokens = nonNegativeInt(value.reasoningTokens);
      const totals = {
        uncachedInputTokens: nonNegativeInt(value.inputTokens),
        cachedInputTokens: nonNegativeInt(value.cacheReadTokens),
        cacheCreationTokens: nonNegativeInt(value.cacheWriteTokens),
        // OpenCode records reasoning separately from visible output. T3's
        // contract models reasoning as a subset of output, so combine them.
        outputTokens: nonNegativeInt(value.outputTokens) + reasoningTokens,
        reasoningTokens,
      };
      if (totalTokens(totals) === 0) {
        // OpenCode creates the assistant row before a provider responds. An
        // interrupted turn can leave that otherwise valid row without a token
        // payload, while cancelled turns persist an all-zero payload. Neither
        // represents usage or a damaged usage record.
        continue;
      }

      const identity = usageIdentity(value);
      const boundary = migrationBoundaries.get(value.sessionId);
      validCandidates.push({
        source: value.source,
        identity,
        coveredByCurrentMigration:
          value.source === "legacy" && boundary !== undefined && value.timestampMs >= boundary,
        record: {
          provider: "opencode",
          timestampMs: value.timestampMs,
          model: `${providerId}/${modelId}`,
          sessionId: value.sessionId,
          totals,
          reportedCostUsd:
            value.costUsd !== null && Number.isFinite(value.costUsd) && value.costUsd >= 0
              ? value.costUsd
              : null,
          dedupeKey: `opencode:${value.id}`,
        },
      });
    }

    // A mixed-schema legacy row at or after its session's first projected
    // assistant is a dual-write, even though the projection is keyed by the
    // generated step event rather than the legacy message ID. Propagate that
    // provenance across identical legacy rows so forked copies are excluded
    // along with the original dual-write.
    const currentOwnedLegacy = new Set(
      validCandidates
        .filter((candidate) => candidate.coveredByCurrentMigration)
        .map((candidate) => candidate.identity),
    );
    const seenBySource = {
      current: new Set<string>(),
      legacy: new Set<string>(),
    };
    const records: UsageRecord[] = [];
    for (const candidate of validCandidates) {
      if (candidate.source === "legacy" && currentOwnedLegacy.has(candidate.identity)) continue;
      const seen = seenBySource[candidate.source];
      if (seen.has(candidate.identity)) continue;
      seen.add(candidate.identity);
      records.push(candidate.record);
    }

    return { status: "ok", schema, records, malformedRecords };
  } catch {
    return {
      status: "failed",
      message: "The OpenCode usage database could not be read.",
    };
  } finally {
    database?.close();
  }
}

/**
 * Reads message-level OpenCode usage without materialising message content.
 * Results are cached until the database or one of its write sidecars changes,
 * keeping the legacy JSON predicate off the server event loop on warm reads.
 *
 * `sinceMs` is only a query prefilter. Exact daily/hourly bounds are still
 * applied by {@link UsageAggregator}, just as they are for transcript files.
 */
export function readOpenCodeUsageRecords(
  databasePath: string,
  sinceMs: number,
): OpenCodeUsageReadResult {
  const before = databaseState(databasePath);
  const cached = usageCache.get(databasePath);
  if (before !== null && cached?.databaseState === before) {
    const result = cached.resultsBySinceMs.get(sinceMs);
    if (result !== undefined) return result;
  }

  const result = readOpenCodeUsageRecordsUncached(databasePath, sinceMs);
  const after = databaseState(databasePath);
  if (result.status === "ok" && before !== null && before === after) {
    const resultsBySinceMs =
      cached?.databaseState === before
        ? cached.resultsBySinceMs
        : new Map<number, OpenCodeUsageReadSuccess>();
    if (!resultsBySinceMs.has(sinceMs) && resultsBySinceMs.size >= MAX_CACHED_WINDOWS) {
      const oldestSinceMs = resultsBySinceMs.keys().next().value;
      if (oldestSinceMs !== undefined) resultsBySinceMs.delete(oldestSinceMs);
    }
    resultsBySinceMs.set(sinceMs, result);
    usageCache.set(databasePath, { databaseState: before, resultsBySinceMs });
  }
  return result;
}
