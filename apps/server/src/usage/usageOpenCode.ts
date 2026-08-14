/**
 * Read-only OpenCode usage database access.
 *
 * OpenCode stores one usage-bearing JSON object per assistant message in its
 * global SQLite database. Both its legacy `message` projection and current
 * `session_message` projection are supported. Only the scalar fields needed for
 * usage reporting are selected; prompts, responses, and tool output never leave
 * the database.
 *
 * @module usageOpenCode
 */
import type { UsageRecord } from "./usageTranscripts.ts";

// Kept non-literal so the Node-targeted bundle leaves Bun's runtime module
// external without asking its resolver to load a module Node cannot provide.
const BUN_SQLITE_MODULE_ID: string = "bun:sqlite";

const OPEN_CODE_STABLE_DATABASE = "opencode.db";
const OPEN_CODE_CHANNEL_DATABASE = /^opencode-[a-zA-Z0-9._-]+\.db$/;

const OPEN_CODE_MESSAGE_TABLES_QUERY = `
  SELECT name
  FROM sqlite_master
  WHERE type = 'table' AND name IN ('session_message', 'message')
`;

const OPEN_CODE_LEGACY_USAGE_QUERY = `
  SELECT
    id AS messageId,
    session_id AS sessionId,
    time_created AS timestampMs,
    json_extract(data, '$.providerID') AS providerId,
    json_extract(data, '$.modelID') AS modelId,
    json_extract(data, '$.tokens.input') AS inputTokens,
    json_extract(data, '$.tokens.output') AS outputTokens,
    json_extract(data, '$.tokens.reasoning') AS reasoningTokens,
    json_extract(data, '$.tokens.cache.read') AS cacheReadTokens,
    json_extract(data, '$.tokens.cache.write') AS cacheWriteTokens,
    json_extract(data, '$.cost') AS costUsd
  FROM message
  WHERE time_created >= ?
    AND json_valid(data)
    AND json_extract(data, '$.role') = 'assistant'
`;

const OPEN_CODE_LEGACY_MALFORMED_QUERY = `
  SELECT COUNT(*) AS records
  FROM message
  WHERE time_created >= ? AND NOT json_valid(data)
`;

const OPEN_CODE_CURRENT_USAGE_QUERY = `
  SELECT
    id AS messageId,
    session_id AS sessionId,
    time_created AS timestampMs,
    json_extract(data, '$.model.providerID') AS providerId,
    json_extract(data, '$.model.id') AS modelId,
    json_extract(data, '$.tokens.input') AS inputTokens,
    json_extract(data, '$.tokens.output') AS outputTokens,
    json_extract(data, '$.tokens.reasoning') AS reasoningTokens,
    json_extract(data, '$.tokens.cache.read') AS cacheReadTokens,
    json_extract(data, '$.tokens.cache.write') AS cacheWriteTokens,
    json_extract(data, '$.cost') AS costUsd
  FROM session_message
  WHERE time_created >= ?
    AND type = 'assistant'
    AND json_valid(data)
`;

const OPEN_CODE_CURRENT_MALFORMED_QUERY = `
  SELECT COUNT(*) AS records
  FROM session_message
  WHERE time_created >= ?
    AND type = 'assistant'
    AND NOT json_valid(data)
`;

const OPEN_CODE_TABLE_QUERIES = {
  session_message: {
    usage: OPEN_CODE_CURRENT_USAGE_QUERY,
    malformed: OPEN_CODE_CURRENT_MALFORMED_QUERY,
  },
  message: {
    usage: OPEN_CODE_LEGACY_USAGE_QUERY,
    malformed: OPEN_CODE_LEGACY_MALFORMED_QUERY,
  },
} as const;

type OpenCodeMessageTable = keyof typeof OPEN_CODE_TABLE_QUERIES;

interface OpenCodeUsageRow {
  readonly messageId?: unknown;
  readonly sessionId?: unknown;
  readonly timestampMs?: unknown;
  readonly providerId?: unknown;
  readonly modelId?: unknown;
  readonly inputTokens?: unknown;
  readonly outputTokens?: unknown;
  readonly reasoningTokens?: unknown;
  readonly cacheReadTokens?: unknown;
  readonly cacheWriteTokens?: unknown;
  readonly costUsd?: unknown;
}

interface CountRow {
  readonly records?: unknown;
}

interface TableNameRow {
  readonly name?: unknown;
}

interface SqliteStatement {
  readonly all: (...parameters: readonly number[]) => readonly unknown[];
}

interface SqliteDatabase {
  readonly statement: (sql: string) => SqliteStatement;
  readonly close: () => void;
}

export interface OpenCodeUsageRead {
  readonly records: readonly UsageRecord[];
  readonly malformedRecords: number;
}

export interface ResolveOpenCodeDatabasePathsInput {
  readonly dataDir: string;
  readonly databaseOverride: string | undefined;
  readonly disableChannelDatabase: string | undefined;
  readonly directoryEntries: readonly string[];
  readonly path: {
    readonly isAbsolute: (value: string) => boolean;
    readonly join: (first: string, ...segments: readonly string[]) => string;
  };
}

/** Mirrors OpenCode's explicit override and discovers compile-time channel databases. */
export function resolveOpenCodeDatabasePaths({
  dataDir,
  databaseOverride,
  disableChannelDatabase,
  directoryEntries,
  path,
}: ResolveOpenCodeDatabasePathsInput): readonly string[] {
  const override = databaseOverride?.trim();
  if (override) {
    if (override === ":memory:") return [];
    return [path.isAbsolute(override) ? override : path.join(dataDir, override)];
  }

  const stableDatabasePath = path.join(dataDir, OPEN_CODE_STABLE_DATABASE);
  const channelsDisabled = ["1", "true"].includes(
    disableChannelDatabase?.trim().toLowerCase() ?? "",
  );
  if (channelsDisabled) return [stableDatabasePath];

  const databaseNames = directoryEntries.filter(
    (entry) => entry === OPEN_CODE_STABLE_DATABASE || OPEN_CODE_CHANNEL_DATABASE.test(entry),
  );
  if (databaseNames.length === 0) return [stableDatabasePath];

  return [...new Set(databaseNames)]
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => path.join(dataDir, entry));
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

type OpenCodeUsageRowParse =
  | { readonly _tag: "Malformed" }
  | { readonly _tag: "Placeholder" }
  | { readonly _tag: "Record"; readonly record: UsageRecord };

function decodeOpenCodeUsageRow(value: unknown): OpenCodeUsageRowParse {
  if (typeof value !== "object" || value === null) return { _tag: "Malformed" };
  const row = value as OpenCodeUsageRow;
  if (
    typeof row.messageId !== "string" ||
    row.messageId.length === 0 ||
    typeof row.sessionId !== "string" ||
    typeof row.timestampMs !== "number" ||
    !Number.isFinite(row.timestampMs) ||
    typeof row.providerId !== "string" ||
    row.providerId.length === 0 ||
    typeof row.modelId !== "string" ||
    row.modelId.length === 0
  ) {
    return { _tag: "Malformed" };
  }

  const uncachedInputTokens = nonNegativeInt(row.inputTokens);
  const cachedInputTokens = nonNegativeInt(row.cacheReadTokens);
  const cacheCreationTokens = nonNegativeInt(row.cacheWriteTokens);
  const generatedOutputTokens = nonNegativeInt(row.outputTokens);
  const reasoningTokens = nonNegativeInt(row.reasoningTokens);

  // OpenCode reports generated text and reasoning as disjoint counts. The
  // shared contract treats reasoning as a subset of output, so combine them in
  // outputTokens while retaining the reasoning slice for the token-mix UI.
  const outputTokens = generatedOutputTokens + reasoningTokens;
  if (uncachedInputTokens + cachedInputTokens + cacheCreationTokens + outputTokens === 0) {
    return { _tag: "Placeholder" };
  }

  return {
    _tag: "Record",
    record: {
      provider: "opencode",
      timestampMs: row.timestampMs,
      model: `${row.providerId}/${row.modelId}`,
      sessionId: row.sessionId,
      totals: {
        uncachedInputTokens,
        cachedInputTokens,
        cacheCreationTokens,
        outputTokens,
        reasoningTokens,
      },
      reportedCostUsd: finiteNonNegative(row.costUsd),
      dedupeKey: `opencode:${row.messageId}`,
    },
  };
}

/** Converts one assistant-message projection into the shared usage shape. */
export function parseOpenCodeUsageRow(value: unknown): UsageRecord | null {
  const parsed = decodeOpenCodeUsageRow(value);
  return parsed._tag === "Record" ? parsed.record : null;
}

async function openDatabase(databasePath: string): Promise<SqliteDatabase> {
  if (process.versions.bun !== undefined) {
    const { Database } = (await import(BUN_SQLITE_MODULE_ID)) as typeof import("bun:sqlite");
    const database = new Database(databasePath, { readonly: true, create: false });
    return {
      statement: (sql) => {
        const statement = database.query(sql);
        return { all: (...parameters) => statement.all(...parameters) };
      },
      close: () => database.close(),
    };
  }

  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  return {
    statement: (sql) => {
      const statement = database.prepare(sql);
      return { all: (...parameters) => statement.all(...parameters) };
    },
    close: () => database.close(),
  };
}

/**
 * Reads assistant usage at or after `sinceMs`, returning `null` when the
 * database is unavailable or has an unsupported schema.
 */
export async function readOpenCodeUsage(
  databasePath: string,
  sinceMs: number,
): Promise<OpenCodeUsageRead | null> {
  let database: SqliteDatabase | undefined;
  try {
    database = await openDatabase(databasePath);
    const tableRows = database.statement(OPEN_CODE_MESSAGE_TABLES_QUERY).all();
    const tables = new Set<OpenCodeMessageTable>();
    for (const row of tableRows) {
      const name = (row as TableNameRow).name;
      if (name === "session_message" || name === "message") tables.add(name);
    }
    if (tables.size === 0) return null;

    // Current databases can contain both projections. Prefer the current row
    // when an upgraded database carries the same message ID in each table.
    const recordsByKey = new Map<string, UsageRecord>();
    let malformedRecords = 0;
    for (const table of ["session_message", "message"] as const) {
      if (!tables.has(table)) continue;
      const queries = OPEN_CODE_TABLE_QUERIES[table];
      const rows = database.statement(queries.usage).all(sinceMs);
      for (const row of rows) {
        const parsed = decodeOpenCodeUsageRow(row);
        if (parsed._tag === "Record") {
          const dedupeKey = parsed.record.dedupeKey;
          if (dedupeKey === null) {
            malformedRecords += 1;
          } else if (!recordsByKey.has(dedupeKey)) {
            recordsByKey.set(dedupeKey, parsed.record);
          }
        } else if (parsed._tag === "Malformed") {
          malformedRecords += 1;
        }
      }

      const [malformed] = database.statement(queries.malformed).all(sinceMs);
      malformedRecords += nonNegativeInt((malformed as CountRow | undefined)?.records);
    }

    return { records: [...recordsByKey.values()], malformedRecords };
  } catch {
    return null;
  } finally {
    try {
      database?.close();
    } catch {
      // A failed close must not turn a successful read into a failed RPC.
    }
  }
}
