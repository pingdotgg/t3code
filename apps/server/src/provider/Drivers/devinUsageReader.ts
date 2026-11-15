// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's File.Info lacks the identity fields the cache fingerprint needs.
import * as NodeFSP from "node:fs/promises";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  totalTokens,
  type ProviderUsageReader,
  type ProviderUsageScan,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

// The sessions database holds a whole conversation forest, so there is no per-instance
// configuration to read; discovery goes through environment variables only.
export const DevinUsageConfig = Schema.Struct({});
export type DevinUsageConfig = Schema.Schema.Type<typeof DevinUsageConfig>;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

// Devin appends a thinking-effort suffix to model names; the base name carries the price.
export const devinRateModel = (model: string) =>
  model.replace(/-(?:low|medium|high|xhigh|max)$/, "");

interface MessageRow {
  readonly row_id: number;
  readonly session_id: unknown;
  readonly created_at: unknown;
  readonly fields: unknown;
  readonly session_model: unknown;
}

function recordFromRow(row: MessageRow): UsageRecord | null {
  const sessionId = text(row.session_id);
  if (!sessionId) return null;
  // One json_extract with many paths reads its arguments as one JSON array.
  let fields: unknown;
  try {
    fields = JSON.parse(text(row.fields));
  } catch {
    return null;
  }
  if (!Array.isArray(fields) || fields.length !== 6) return null;
  const [requestId, generationModel, input, output, cacheRead, cacheCreation] = fields;
  const model = text(generationModel) || text(row.session_model);
  if (!model) return null;
  const rateModel = devinRateModel(model);
  const createdAt = row.created_at;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt) || createdAt <= 0) return null;
  const totals = {
    uncachedInputTokens: tokens(input),
    cachedInputTokens: tokens(cacheRead),
    cacheCreationTokens: tokens(cacheCreation),
    outputTokens: tokens(output),
    reasoningTokens: 0,
  };
  if (totalTokens(totals) === 0) return null;
  return {
    provider: "devin",
    timestampMs: createdAt > 1e12 ? createdAt : createdAt * 1000,
    model,
    ...(rateModel === model ? {} : { rateModel }),
    sessionId,
    totals,
    // Devin records no local costs; billing lives on the Devin account.
    reportedCostUsd: null,
    speed: "standard",
    // Context rebuilds re-save earlier responses under new node ids; the request id is stable.
    dedupeKey: requestId
      ? `devin:${sessionId}:${text(requestId)}`
      : `devin:${sessionId}:node:${row.row_id}`,
  };
}

const PAGE_ROWS = 512;

const readDevinDatabase = Effect.fn("readDevinDatabase")(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Fail promptly on live-writer locks instead of stalling the server.
  yield* sql.unsafe("PRAGMA busy_timeout = 100");
  const tables = new Set(
    (yield* sql.unsafe<{ readonly name: unknown }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    )).map((row) => row.name),
  );
  if (!tables.has("message_nodes") || !tables.has("sessions")) {
    return { records: [] as UsageRecord[], error: true };
  }
  const records: UsageRecord[] = [];
  const seen = new Set<string>();
  let after = 0;
  while (true) {
    const rows = yield* sql
      .unsafe<MessageRow>(
        `SELECT nodes.row_id AS row_id, nodes.session_id AS session_id,
					nodes.created_at AS created_at,
					json_extract(nodes.chat_message,
						'$.metadata.request_id', '$.metadata.generation_model',
						'$.metadata.metrics.input_tokens', '$.metadata.metrics.output_tokens',
						'$.metadata.metrics.cache_read_tokens', '$.metadata.metrics.cache_creation_tokens'
					) AS fields,
					sessions.model AS session_model
				FROM message_nodes AS nodes
				JOIN sessions ON sessions.id = nodes.session_id
				WHERE json_valid(nodes.chat_message)
					AND json_extract(nodes.chat_message, '$.role') = 'assistant'
					AND nodes.row_id > ?
				ORDER BY nodes.row_id
				LIMIT ?`,
        [after, PAGE_ROWS],
      )
      .pipe(Effect.withTracerEnabled(false));
    for (const row of rows) {
      const record = recordFromRow(row);
      if (record === null || record.dedupeKey === null || seen.has(record.dedupeKey)) continue;
      seen.add(record.dedupeKey);
      records.push(record);
    }
    if (rows.length < PAGE_ROWS) break;
    after = rows[rows.length - 1]!.row_id;
    yield* Effect.yieldNow;
  }
  return { records, error: false };
});

interface CachedDatabase {
  readonly fingerprint: string;
  readonly records: readonly UsageRecord[];
}

// Parsed records by canonical database path. The fingerprint covers the main file and its
// WAL, so a replaced database or a WAL commit is re-read.
const databaseCache = new Map<string, CachedDatabase>();
// Concurrent scans of the same directory would each re-read every row.
const scanLock = Semaphore.makeUnsafe(1);

interface DevinUsageReadResult {
  readonly canonical: string;
  readonly records: readonly UsageRecord[];
  readonly missing: boolean;
  readonly error: boolean;
}

const readDevinUsage = Effect.fn("readDevinUsage")(function* (
  dir: string,
  sinceMs: number,
): Effect.fn.Return<DevinUsageReadResult, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const database = path.join(dir, "sessions.db");
  const canonical = yield* fileSystem.realPath(database).pipe(Effect.orElseSucceed(() => database));
  const stamp = (file: string) =>
    Effect.tryPromise({
      try: () => NodeFSP.stat(file),
      catch: () => "unavailable",
    }).pipe(
      Effect.map(
        (stat) => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.size}:${stat.mtimeMs}`,
      ),
      Effect.option,
      Effect.map(Option.getOrElse(() => "unavailable")),
    );
  const main = yield* stamp(database);
  if (main === "unavailable") {
    return { canonical, records: [], missing: true, error: false };
  }
  const wal = yield* stamp(`${database}-wal`);
  const fingerprint = `${main}/${wal}`;
  const cached = databaseCache.get(canonical);
  if (cached?.fingerprint === fingerprint) {
    return {
      canonical,
      records: cached.records.filter((record) => record.timestampMs >= sinceMs),
      missing: false,
      error: false,
    };
  }
  const read = yield* readDevinDatabase().pipe(
    (effect) => Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(effect)),
    NodeSqliteClient.readOnly,
    Effect.provide(
      NodeSqliteClient.layer({ filename: database, readonly: true, readerWorker: true }),
    ),
    Effect.catchTags({
      SqlError: () => Effect.succeed({ records: [] as UsageRecord[], error: true }),
    }),
  );
  if (!read.error) databaseCache.set(canonical, { fingerprint, records: read.records });
  return {
    canonical,
    records: read.records.filter((record) => record.timestampMs >= sinceMs),
    missing: false,
    error: read.error,
  };
}, scanLock.withPermit);

const resolveDevinSessionsDirs = Effect.fn("resolveDevinSessionsDirs")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const list = (value: string | undefined) =>
    value
      ?.split(",")
      .map((entry) => entry.trim())
      .filter(Boolean) ?? [];
  const sessionsDirs = list(environment["DEVIN_SESSIONS_DIR"]);
  const dataRoots = list(environment["DEVIN_DATA_DIR"]);
  const dataHome = environment["XDG_DATA_HOME"]?.trim();
  const defaults = [
    path.join(
      dataHome && path.isAbsolute(dataHome)
        ? dataHome
        : path.join(homeDirectory, ".local", "share"),
      "devin",
    ),
  ];
  // Explicitly named locations replace the default root; only an unset pair falls back to it.
  const dataDirs = dataRoots.length > 0 ? dataRoots : sessionsDirs.length > 0 ? [] : defaults;
  const dirs = [...sessionsDirs, ...dataDirs.map((root) => path.join(root, "cli"))];
  const canonical = new Set<string>();
  for (const dir of dirs) {
    const resolved = path.resolve(expandHomePath(dir, homeDirectory));
    canonical.add(yield* fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved)));
  }
  return [...canonical];
});

export type DevinUsageReaderEnv = FileSystem.FileSystem | Path.Path;

export const devinUsageReader: ProviderUsageReader<DevinUsageConfig, DevinUsageReaderEnv> = {
  kind: "scan",
  provider: "devin",
  rateModel: devinRateModel,
  scan: Effect.fn("devinUsageReader.scan")(function* ({ instances, windowStartMs }) {
    const path = yield* Path.Path;
    const dirs = new Set<string>();
    for (const instance of instances) {
      for (const dir of yield* resolveDevinSessionsDirs(instance.environment)) dirs.add(dir);
    }
    const results: Array<{ dir: string; result: DevinUsageReadResult }> = [];
    for (const dir of dirs) {
      results.push({ dir, result: yield* readDevinUsage(dir, windowStartMs) });
    }
    const visited = new Set(results.map(({ result }) => result.canonical));
    for (const key of databaseCache.keys()) {
      if (!visited.has(key)) databaseCache.delete(key);
    }
    const scanned: ProviderUsageScan[] = results.map(({ dir, result }) => ({
      dir,
      files:
        result.missing && !result.error
          ? null
          : [{ path: path.join(dir, "sessions.db"), records: result.records }],
      status: result.error ? ("partial" as const) : ("ok" as const),
      ...(result.error ? { message: "Some Devin history could not be read." } : {}),
    }));
    return scanned;
  }),
};
