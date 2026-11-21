import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
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

interface KiloMessageRow {
  readonly id: unknown;
  readonly session_id: unknown;
  readonly time_created: unknown;
  readonly model: unknown;
  readonly provider_id: unknown;
  readonly input: unknown;
  readonly output: unknown;
  readonly reasoning: unknown;
  readonly cache_read: unknown;
  readonly cache_write: unknown;
  readonly cost: unknown;
}

const tokenCount = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;

function kiloUsageRecord(row: KiloMessageRow): UsageRecord | null {
  if (
    typeof row.id !== "string" ||
    typeof row.session_id !== "string" ||
    typeof row.model !== "string" ||
    !row.model.trim() ||
    typeof row.time_created !== "number" ||
    !Number.isFinite(row.time_created)
  ) {
    return null;
  }
  const reasoningTokens = tokenCount(row.reasoning);
  const totals = {
    uncachedInputTokens: tokenCount(row.input),
    cachedInputTokens: tokenCount(row.cache_read),
    cacheCreationTokens: tokenCount(row.cache_write),
    outputTokens: tokenCount(row.output) + reasoningTokens,
    reasoningTokens,
  };
  if (totalTokens(totals) === 0) return null;
  const free = row.provider_id === "kilo" && row.model.endsWith("/free");
  return {
    provider: "kilo",
    timestampMs: row.time_created,
    model: row.model,
    sessionId: row.session_id,
    totals,
    reportedCostUsd:
      typeof row.cost === "number" &&
      Number.isFinite(row.cost) &&
      (row.cost > 0 || (free && row.cost === 0))
        ? row.cost
        : null,
    speed: "standard",
    dedupeKey: `kilo:${row.id}`,
  };
}

const isKiloInstance = (config: AcpRegistrySettings | undefined) =>
  config !== undefined &&
  (["kilo", "kilo-code", "kilocode"].includes(config.agentId.toLowerCase()) ||
    /(?:^|[\\/])kilo(?:\.exe)?$/i.test(config.commandPath));

export type KiloUsageReaderEnv = FileSystem.FileSystem | Path.Path;

export const kiloUsageReader: ProviderUsageReader<AcpRegistrySettings, KiloUsageReaderEnv> = {
  kind: "scan",
  provider: "kilo",
  scan: Effect.fn("kiloUsageReader.scan")(function* ({ instances, windowStartMs }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const databases = new Set<string>();
    for (const { config, environment } of instances) {
      if (!isKiloInstance(config)) continue;
      const configured = environment["KILO_DB"]?.trim();
      const dataHome = environment["XDG_DATA_HOME"]?.trim();
      const database = configured
        ? expandHomePath(configured, home)
        : path.join(
            dataHome && path.isAbsolute(dataHome) ? dataHome : path.join(home, ".local", "share"),
            "kilo",
            "kilo.db",
          );
      databases.add(
        yield* fileSystem.realPath(database).pipe(Effect.orElseSucceed(() => database)),
      );
    }

    return yield* Effect.forEach(databases, (database) =>
      Effect.gen(function* () {
        const dir = path.dirname(database);
        if (!(yield* Effect.isSuccess(fileSystem.stat(database)))) {
          return { dir, files: null, status: "missing" as const };
        }
        return yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe("PRAGMA busy_timeout = 100");
          const rows = yield* sql.unsafe<KiloMessageRow>(
            `SELECT id, session_id, time_created,
               coalesce(data ->> '$.modelID', data ->> '$.model.id') AS model,
               data ->> '$.providerID' AS provider_id,
               data ->> '$.tokens.input' AS input,
               data ->> '$.tokens.output' AS output,
               data ->> '$.tokens.reasoning' AS reasoning,
               data ->> '$.tokens.cache.read' AS cache_read,
               data ->> '$.tokens.cache.write' AS cache_write,
               data ->> '$.cost' AS cost
             FROM message
             WHERE time_created >= ? AND json_valid(data) AND data ->> '$.role' = 'assistant'`,
            [windowStartMs],
          );
          return {
            dir,
            files: [
              {
                path: database,
                records: rows.flatMap((row) => {
                  const record = kiloUsageRecord(row);
                  return record === null ? [] : [record];
                }),
              },
            ],
            status: "ok" as const,
          };
        }).pipe(
          (read) => Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(read)),
          NodeSqliteClient.readOnly,
          Effect.provide(
            NodeSqliteClient.layer({ filename: database, readonly: true, readerWorker: true }),
          ),
          Effect.catchTags({
            SqlError: () =>
              Effect.succeed({
                dir,
                files: null,
                status: "partial" as const,
                message: "Kilo history could not be read.",
              }),
          }),
        );
      }),
    );
  }),
};
