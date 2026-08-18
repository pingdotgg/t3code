// @effect-diagnostics nodeBuiltinImport:off
/**
 * Read-only access to OpenCode's local usage database.
 *
 * OpenCode keeps exact usage on assistant messages. Current releases use the
 * `session_message` table while older releases use `message`. Installations
 * migrating between them may contain both, so rows are unioned by message ID
 * with the current representation winning duplicates.
 *
 * @module usageOpenCodeReader
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";

const OpenCodeUsageRow = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
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
    id,
    session_id AS sessionId,
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
  ORDER BY time_created, id
`;

const LEGACY_USAGE_QUERY = `
  SELECT
    id,
    session_id AS sessionId,
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
  ORDER BY time_created, id
`;

const MIXED_LEGACY_USAGE_QUERY = `
  SELECT
    message.id AS id,
    message.session_id AS sessionId,
    COALESCE(json_extract(message.data, '$.time.completed'), message.time_created) AS timestampMs,
    json_extract(message.data, '$.providerID') AS providerId,
    json_extract(message.data, '$.modelID') AS modelId,
    json_extract(message.data, '$.cost') AS costUsd,
    json_extract(message.data, '$.tokens.input') AS inputTokens,
    json_extract(message.data, '$.tokens.output') AS outputTokens,
    json_extract(message.data, '$.tokens.reasoning') AS reasoningTokens,
    json_extract(message.data, '$.tokens.cache.read') AS cacheReadTokens,
    json_extract(message.data, '$.tokens.cache.write') AS cacheWriteTokens
  FROM message
  WHERE
    json_extract(message.data, '$.role') = 'assistant'
    AND message.time_created >= ?
    AND NOT EXISTS (SELECT 1 FROM session_message WHERE session_message.id = message.id)
  ORDER BY message.time_created, message.id
`;

/**
 * Reads message-level OpenCode usage without materialising message content.
 *
 * `sinceMs` is only a query prefilter. Exact daily/hourly bounds are still
 * applied by {@link UsageAggregator}, just as they are for transcript files.
 */
export function readOpenCodeUsageRecords(
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
              ...database.prepare(MIXED_LEGACY_USAGE_QUERY).all(sinceMs),
            ];
    const decodedRows = decodeOpenCodeUsageRows(rows);
    const candidates = Option.isSome(decodedRows)
      ? decodedRows.value.map((value) => Option.some(value))
      : rows.map((row) => decodeOpenCodeUsageRow(row));
    const records: UsageRecord[] = [];
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
        const hasTokenPayload = [
          value.inputTokens,
          value.outputTokens,
          value.reasoningTokens,
          value.cacheReadTokens,
          value.cacheWriteTokens,
        ].some((tokenCount) => tokenCount !== null);
        if (!hasTokenPayload) malformedRecords += 1;
        continue;
      }

      records.push({
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
      });
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
