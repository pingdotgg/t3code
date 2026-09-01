// @effect-diagnostics nodeBuiltinImport:off
/**
 * Read-only access to OpenCode's SQLite usage store.
 *
 * Queries project only message identity, model, timestamp, token, and cost
 * scalars. Prompt text, assistant output, and tool content never leave SQLite.
 *
 * @module usageOpenCode
 */
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import type { UsageRecord } from "./usageTranscripts.ts";

// Keep this non-literal at runtime so Node-targeted bundles do not try to
// resolve Bun's built-in module.
const BUN_SQLITE_MODULE_ID: string = "bun:sqlite";

const OPEN_CODE_DATABASE_NAME = "opencode.db";
const OPEN_CODE_CHANNEL_DATABASE = /^opencode-[a-zA-Z0-9._-]+\.db$/;
const SQLITE_BUSY_TIMEOUT_MS = 1_000;

const TABLES_QUERY = `
  SELECT name
  FROM sqlite_master
  WHERE type = 'table' AND name IN ('session_message', 'message')
`;

const LEGACY_USAGE_QUERY = `
  SELECT
    id AS messageId,
    session_id AS sessionId,
    json_extract(data, '$.time.completed') AS timestampMs,
    json_extract(data, '$.providerID') AS providerId,
    json_extract(data, '$.modelID') AS modelId,
    json_extract(data, '$.tokens.input') AS inputTokens,
    json_extract(data, '$.tokens.output') AS outputTokens,
    json_extract(data, '$.tokens.reasoning') AS reasoningTokens,
    json_extract(data, '$.tokens.cache.read') AS cacheReadTokens,
    json_extract(data, '$.tokens.cache.write') AS cacheWriteTokens,
    json_extract(data, '$.cost') AS costUsd
  FROM message
  WHERE time_updated >= ?
    AND CASE WHEN json_valid(data) THEN json_extract(data, '$.role') END = 'assistant'
    AND CASE WHEN json_valid(data) THEN json_extract(data, '$.time.completed') END >= ?
`;

const LEGACY_MALFORMED_QUERY = `
  SELECT COUNT(*) AS records
  FROM message
  WHERE time_updated >= ? AND NOT json_valid(data)
`;

const CURRENT_USAGE_QUERY = `
  SELECT
    id AS messageId,
    session_id AS sessionId,
    json_extract(data, '$.time.completed') AS timestampMs,
    json_extract(data, '$.model.providerID') AS providerId,
    json_extract(data, '$.model.id') AS modelId,
    json_extract(data, '$.tokens.input') AS inputTokens,
    json_extract(data, '$.tokens.output') AS outputTokens,
    json_extract(data, '$.tokens.reasoning') AS reasoningTokens,
    json_extract(data, '$.tokens.cache.read') AS cacheReadTokens,
    json_extract(data, '$.tokens.cache.write') AS cacheWriteTokens,
    json_extract(data, '$.cost') AS costUsd
  FROM session_message
  WHERE type = 'assistant' AND time_updated >= ?
    AND CASE WHEN json_valid(data) THEN json_extract(data, '$.time.completed') END >= ?
`;

const CURRENT_MALFORMED_QUERY = `
  SELECT COUNT(*) AS records
  FROM session_message
  WHERE type = 'assistant' AND time_updated >= ? AND NOT json_valid(data)
`;

const TABLE_QUERIES = {
  session_message: { usage: CURRENT_USAGE_QUERY, malformed: CURRENT_MALFORMED_QUERY },
  message: { usage: LEGACY_USAGE_QUERY, malformed: LEGACY_MALFORMED_QUERY },
} as const;

type OpenCodeMessageTable = keyof typeof TABLE_QUERIES;

const NonEmptyString = Schema.String.check(Schema.isNonEmpty());
const NullableFinite = Schema.NullOr(Schema.Finite);
const OpenCodeUsageRow = Schema.Struct({
  messageId: NonEmptyString,
  sessionId: NonEmptyString,
  timestampMs: Schema.Finite,
  providerId: NonEmptyString,
  modelId: NonEmptyString,
  inputTokens: NullableFinite,
  outputTokens: NullableFinite,
  reasoningTokens: NullableFinite,
  cacheReadTokens: NullableFinite,
  cacheWriteTokens: NullableFinite,
  costUsd: NullableFinite,
});
const decodeOpenCodeUsageRow = Schema.decodeUnknownExit(OpenCodeUsageRow);

const CountRow = Schema.Struct({ records: Schema.Finite });
const decodeCountRow = Schema.decodeUnknownExit(CountRow);

const TableRow = Schema.Struct({ name: Schema.String });
const decodeTableRow = Schema.decodeUnknownExit(TableRow);

interface SqliteStatement {
  readonly all: (...parameters: readonly number[]) => readonly unknown[];
}

interface SqliteDatabase {
  readonly prepare: (sql: string) => SqliteStatement;
  readonly close: () => void;
}

export interface OpenCodeUsageRead {
  readonly records: readonly UsageRecord[];
  readonly malformedRecords: number;
}

export interface ResolveOpenCodeDatabasePathsInput {
  readonly dataDirectory: string;
  readonly databaseOverride: string | undefined;
  readonly disableChannelDatabase: string | undefined;
  readonly directoryEntries: readonly string[];
  readonly path: {
    readonly isAbsolute: (value: string) => boolean;
    readonly join: (first: string, ...segments: readonly string[]) => string;
  };
}

/** Mirrors OpenCode's explicit override and compile-time channel database naming. */
export function resolveOpenCodeDatabasePaths({
  dataDirectory,
  databaseOverride,
  disableChannelDatabase,
  directoryEntries,
  path,
}: ResolveOpenCodeDatabasePathsInput): readonly string[] {
  const override = databaseOverride?.trim();
  if (override !== undefined && override.length > 0) {
    if (override === ":memory:") return [];
    return [path.isAbsolute(override) ? override : path.join(dataDirectory, override)];
  }

  const stablePath = path.join(dataDirectory, OPEN_CODE_DATABASE_NAME);
  const channelsDisabled = ["1", "true"].includes(
    disableChannelDatabase?.trim().toLowerCase() ?? "",
  );
  if (channelsDisabled) return [stablePath];

  const databaseNames = directoryEntries.filter(
    (entry) => entry === OPEN_CODE_DATABASE_NAME || OPEN_CODE_CHANNEL_DATABASE.test(entry),
  );
  if (databaseNames.length === 0) return [stablePath];

  return [...new Set(databaseNames)]
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => path.join(dataDirectory, entry));
}

function nonNegativeInt(value: number | null): number {
  return value !== null && value > 0 ? Math.trunc(value) : 0;
}

type ParsedOpenCodeUsageRow =
  | { readonly _tag: "record"; readonly record: UsageRecord }
  | { readonly _tag: "placeholder" }
  | { readonly _tag: "malformed" };

function decodeUsageRow(value: unknown): ParsedOpenCodeUsageRow {
  const decoded = decodeOpenCodeUsageRow(value);
  if (!Exit.isSuccess(decoded)) return { _tag: "malformed" };

  const row = decoded.value;
  const reasoningTokens = nonNegativeInt(row.reasoningTokens);
  const generatedOutputTokens = nonNegativeInt(row.outputTokens);
  const totals = {
    uncachedInputTokens: nonNegativeInt(row.inputTokens),
    cachedInputTokens: nonNegativeInt(row.cacheReadTokens),
    cacheCreationTokens: nonNegativeInt(row.cacheWriteTokens),
    // OpenCode stores generated output and reasoning as disjoint counts. The
    // shared contract carries reasoning as a subset of output.
    outputTokens: generatedOutputTokens + reasoningTokens,
    reasoningTokens,
  };

  const totalTokens =
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens;
  // OpenCode can persist an assistant placeholder before any tokens arrive.
  // It is not usage and should not make an otherwise healthy source partial.
  if (totalTokens === 0) return { _tag: "placeholder" };

  return {
    _tag: "record",
    record: {
      provider: "opencode",
      timestampMs: Math.trunc(row.timestampMs),
      model: `${row.providerId}/${row.modelId}`,
      sessionId: row.sessionId,
      totals,
      // A zero is commonly emitted by subscription-backed providers. Let the
      // shared LiteLLM table estimate those models instead of claiming $0 API cost.
      reportedCostUsd: row.costUsd !== null && row.costUsd > 0 ? row.costUsd : null,
      dedupeKey: `opencode:${row.messageId}`,
    },
  };
}

/** Converts one assistant-message projection into the shared usage shape. */
export function parseOpenCodeUsageRow(value: unknown): UsageRecord | null {
  const parsed = decodeUsageRow(value);
  return parsed._tag === "record" ? parsed.record : null;
}

async function openDatabase(databasePath: string): Promise<SqliteDatabase> {
  if (process.versions.bun !== undefined) {
    const { Database } = (await import(BUN_SQLITE_MODULE_ID)) as typeof import("bun:sqlite");
    const database = new Database(databasePath, { readonly: true, create: false });
    database.run(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    return {
      prepare: (sql) => {
        const statement = database.query(sql);
        return { all: (...parameters) => statement.all(...parameters) };
      },
      close: () => database.close(),
    };
  }

  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(databasePath, {
    readOnly: true,
    timeout: SQLITE_BUSY_TIMEOUT_MS,
  });
  return {
    prepare: (sql) => {
      const statement = database.prepare(sql);
      return { all: (...parameters) => statement.all(...parameters) };
    },
    close: () => database.close(),
  };
}

/**
 * Reads completed OpenCode assistant usage at or after `sinceMs`.
 *
 * Current databases may carry both the V2 `session_message` projection and the
 * legacy `message` projection. The current row wins when both contain the same
 * message ID. Returns `null` when the file or schema cannot be read.
 */
export async function readOpenCodeUsage(
  databasePath: string,
  sinceMs: number,
): Promise<OpenCodeUsageRead | null> {
  let database: SqliteDatabase | undefined;
  try {
    database = await openDatabase(databasePath);

    const tables = new Set<OpenCodeMessageTable>();
    for (const value of database.prepare(TABLES_QUERY).all()) {
      const decoded = decodeTableRow(value);
      if (!Exit.isSuccess(decoded)) continue;
      if (decoded.value.name === "session_message" || decoded.value.name === "message") {
        tables.add(decoded.value.name);
      }
    }
    if (tables.size === 0) return null;

    const recordsByMessage = new Map<string, UsageRecord>();
    let malformedRecords = 0;
    for (const table of ["session_message", "message"] as const) {
      if (!tables.has(table)) continue;
      const queries = TABLE_QUERIES[table];
      for (const value of database.prepare(queries.usage).all(sinceMs, sinceMs)) {
        const parsed = decodeUsageRow(value);
        if (parsed._tag === "malformed") {
          malformedRecords += 1;
          continue;
        }
        if (parsed._tag === "placeholder") continue;
        const record = parsed.record;
        if (record.dedupeKey !== null && !recordsByMessage.has(record.dedupeKey)) {
          recordsByMessage.set(record.dedupeKey, record);
        }
      }

      const [countValue] = database.prepare(queries.malformed).all(sinceMs);
      const count = decodeCountRow(countValue);
      if (Exit.isSuccess(count)) malformedRecords += Math.max(0, Math.trunc(count.value.records));
    }

    return { records: [...recordsByMessage.values()], malformedRecords };
  } catch {
    return null;
  } finally {
    try {
      database?.close();
    } catch {
      // A close failure cannot invalidate an otherwise complete read.
    }
  }
}
