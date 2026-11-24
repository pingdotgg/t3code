import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import type { AcpRegistrySettings } from "../settings.ts";

const PAGE_SIZE = 500;

export function isDevinAcpRegistryConfig(config: AcpRegistrySettings | undefined): boolean {
  if (config === undefined) return false;
  if (config.source === "local") return /(?:^|[\\/])devin(?:\.exe)?$/i.test(config.commandPath);
  return config.agentId === "devin";
}

// Devin names models with a trailing reasoning effort; public rates list the base model.
export function devinRateModel(model: string): string {
  return model.replace(/-(?:none|minimal|low|medium|high|xhigh|max)$/, "");
}

interface DevinMessageRow {
  readonly row_id: number;
  readonly session_id: unknown;
  readonly created_at: unknown;
  readonly message_id: unknown;
  readonly request_id: unknown;
  readonly message_created_at: unknown;
  readonly generation_model: unknown;
  readonly session_model: unknown;
  readonly input_tokens: unknown;
  readonly output_tokens: unknown;
  readonly cache_read_tokens: unknown;
  readonly cache_creation_tokens: unknown;
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

function parseDevinMessage(row: DevinMessageRow): UsageRecord | null {
  // Devin's input count excludes cache reads and writes.
  const totals = {
    uncachedInputTokens: tokenCount(row.input_tokens),
    cachedInputTokens: tokenCount(row.cache_read_tokens),
    cacheCreationTokens: tokenCount(row.cache_creation_tokens),
    outputTokens: tokenCount(row.output_tokens),
    reasoningTokens: 0,
  };
  const model = text(row.generation_model) || text(row.session_model);
  if (totalTokens(totals) === 0 || model === "") return null;
  const timestampMs =
    parseTimestampMs(row.message_created_at) ??
    (typeof row.created_at === "number" ? row.created_at * 1_000 : null);
  if (timestampMs === null) return null;
  const id = text(row.request_id) || text(row.message_id);
  const rateModel = devinRateModel(model);
  return {
    provider: "devin",
    timestampMs,
    model,
    ...(rateModel === model ? {} : { rateModel }),
    sessionId: text(row.session_id),
    totals,
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey: id ? `devin:${id}` : null,
  };
}

interface DevinUsageReadResult {
  readonly records: readonly UsageRecord[];
  readonly missing: boolean;
  readonly error: boolean;
}

const readDevinUsage = Effect.fn("readDevinUsage")(function* (
  filename: string,
  sinceMs: number,
): Effect.fn.Return<DevinUsageReadResult, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const exists = yield* fileSystem.exists(filename).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return { records: [], missing: true, error: false };
  const records: UsageRecord[] = [];
  const seen = new Set<string>();
  let error = false;
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Devin writes this database live; fail promptly on its locks instead of stalling the server.
    yield* sql.unsafe("PRAGMA busy_timeout = 100");
    const tables = new Set(
      (yield* sql.unsafe<{ readonly name: unknown }>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      )).map((row) => row.name),
    );
    if (!tables.has("message_nodes") || !tables.has("sessions")) {
      error = true;
      return;
    }
    // Branches copy an inference into newer rows, so the row-time filter never drops in-window usage.
    const sinceSeconds = Math.floor(sinceMs / 1_000);
    let after = 0;
    while (true) {
      const rows = yield* sql
        .unsafe<DevinMessageRow>(
          `SELECT m.row_id, m.session_id, m.created_at,
             m.chat_message ->> '$.message_id' AS message_id,
             m.chat_message ->> '$.metadata.request_id' AS request_id,
             m.chat_message ->> '$.metadata.created_at' AS message_created_at,
             m.chat_message ->> '$.metadata.generation_model' AS generation_model,
             s.model AS session_model,
             m.chat_message ->> '$.metadata.metrics.input_tokens' AS input_tokens,
             m.chat_message ->> '$.metadata.metrics.output_tokens' AS output_tokens,
             m.chat_message ->> '$.metadata.metrics.cache_read_tokens' AS cache_read_tokens,
             m.chat_message ->> '$.metadata.metrics.cache_creation_tokens' AS cache_creation_tokens
           FROM message_nodes AS m
           LEFT JOIN sessions AS s ON s.id = m.session_id
           WHERE m.row_id > ? AND m.created_at >= ?
             AND CASE WHEN json_valid(m.chat_message)
               THEN m.chat_message ->> '$.role' = 'assistant' END
           ORDER BY m.row_id
           LIMIT ${PAGE_SIZE}`,
          [after, sinceSeconds],
        )
        .pipe(Effect.withTracerEnabled(false));
      for (const row of rows) {
        const record = parseDevinMessage(row);
        if (record === null || record.timestampMs < sinceMs) continue;
        if (record.dedupeKey !== null) {
          if (seen.has(record.dedupeKey)) continue;
          seen.add(record.dedupeKey);
        }
        records.push(record);
      }
      if (rows.length < PAGE_SIZE) break;
      after = rows[rows.length - 1]!.row_id;
      yield* Effect.yieldNow;
    }
  }).pipe(
    (read) => Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(read)),
    // Run the scan on a reader worker so a large history does not block the server's event loop.
    NodeSqliteClient.readOnly,
    Effect.provide(NodeSqliteClient.layer({ filename, readonly: true, readerWorker: true })),
    Effect.catchTags({
      SqlError: () => {
        error = true;
        return Effect.void;
      },
    }),
  );
  return { records, missing: false, error };
});

const resolveDevinDataDir = Effect.fn("resolveDevinDataDir")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const dataHome = environment["XDG_DATA_HOME"]?.trim();
  const dir = path.join(
    dataHome && path.isAbsolute(dataHome) ? dataHome : path.join(homeDirectory, ".local", "share"),
    "devin",
    "cli",
  );
  return yield* fileSystem.realPath(dir).pipe(Effect.orElseSucceed(() => dir));
});

export type DevinUsageReaderEnv = FileSystem.FileSystem | Path.Path;

export const devinUsageReader: ProviderUsageReader<AcpRegistrySettings, DevinUsageReaderEnv> = {
  kind: "scan",
  provider: "devin",
  rateModel: devinRateModel,
  scan: Effect.fn("devinUsageReader.scan")(function* ({ instances, windowStartMs }) {
    const path = yield* Path.Path;
    const dirs = new Set<string>();
    for (const instance of instances) {
      if (!isDevinAcpRegistryConfig(instance.config)) continue;
      dirs.add(yield* resolveDevinDataDir(instance.environment));
    }
    return yield* Effect.forEach(
      dirs,
      (dir) => {
        const filename = path.join(dir, "sessions.db");
        return readDevinUsage(filename, windowStartMs).pipe(
          Effect.map((result) => ({
            dir,
            files: result.missing ? null : [{ path: filename, records: result.records }],
            status: result.error ? ("partial" as const) : ("ok" as const),
            ...(result.error ? { message: "Some Devin history could not be read." } : {}),
          })),
        );
      },
      { concurrency: "unbounded" },
    );
  }),
};
