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
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import type { OpenCodeSettings } from "../settings.ts";

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// OpenCode provider IDs whose bare model IDs LiteLLM prices under its own prefix.
const LITELLM_PREFIXES = new Map([["opencode-go", "opencode_go"]]);
const OPENCODE_GATEWAYS = new Set(["opencode", "opencode-go"]);

function parseOpenCodeMessage(
  source: string,
  fallback: {
    readonly id?: string;
    readonly sessionId?: string;
    readonly timestampMs?: number;
  } = {},
): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  const message = object(parsed);
  if (message.role !== undefined && message.role !== "assistant") return null;
  const usage = object(message.tokens);
  const cache = object(usage.cache);
  const modelReference = object(message.model);
  const model = text(modelReference.id) || text(modelReference.modelID) || text(message.modelID);
  const providerId = text(modelReference.providerID) || text(message.providerID);
  const timestampMs = object(message.time).created ?? fallback.timestampMs;
  if (!model || typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) return null;
  const reasoningTokens = tokens(usage.reasoning);
  const totals = {
    uncachedInputTokens: tokens(usage.input),
    cachedInputTokens: tokens(cache.read),
    cacheCreationTokens: tokens(cache.write),
    outputTokens: tokens(usage.output) + reasoningTokens,
    reasoningTokens,
  };
  if (totalTokens(totals) === 0) return null;
  const id = fallback.id || text(message.id);
  const cost = message.cost;
  const prefix = LITELLM_PREFIXES.get(providerId);
  const free = OPENCODE_GATEWAYS.has(providerId) && model.endsWith("-free");
  return {
    provider: "opencode",
    timestampMs,
    model,
    ...(prefix !== undefined && !model.includes("/") ? { rateModel: `${prefix}/${model}` } : {}),
    sessionId: fallback.sessionId || text(message.sessionID),
    totals,
    // OpenCode records zero for unknown rates and paid subscriptions alike, so only its own
    // gateways' free models report zero; shared pricing estimates every other zero.
    reportedCostUsd:
      typeof cost === "number" && Number.isFinite(cost) && (cost > 0 || (free && cost === 0))
        ? cost
        : null,
    speed: "standard",
    dedupeKey: id ? `opencode:${id}` : null,
  };
}

export interface OpenCodeUsageReadResult {
  readonly files: readonly { readonly path: string; readonly records: readonly UsageRecord[] }[];
  readonly missing: boolean;
  readonly error: boolean;
}

interface CachedRow {
  readonly updated: unknown;
  readonly size: unknown;
  readonly created: unknown;
  readonly record: UsageRecord | null;
}

// Parsed rows by `${databasePath}\0${table}`, then rowid, so unchanged rows are not read again.
const rowCache = new Map<string, { version: string; rows: Map<number, CachedRow> }>();
// Concurrent scans of the same database would each read every uncached row.
const scanLock = Semaphore.makeUnsafe(1);

const isNotFound = (cause: PlatformError.PlatformError) => cause.reason._tag === "NotFound";
const MESSAGE_PAGE_SIZE = 64;

const isSymbolicLink = Effect.fnUntraced(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* Effect.isSuccess(fileSystem.readLink(path));
});

const entryInfo = Effect.fn("entryInfo")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  if (yield* isSymbolicLink(path))
    return { type: "SymbolicLink" as const, mtime: Option.none<Date>() };
  return yield* fileSystem.stat(path);
});

const LEGACY_STAT_CONCURRENCY = 4;

// Batch stats so huge directories do not stay in memory.
const LEGACY_STAT_BATCH = 256;

export const readOpenCodeUsage = Effect.fn("readOpenCodeUsage")(function* (
  root: string,
  sinceMs: number,
  retentionCutoffMs = sinceMs,
): Effect.fn.Return<OpenCodeUsageReadResult, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: { path: string; records: UsageRecord[] }[] = [];
  const seen = new Set<string>();
  let found = false;
  let error = false;
  let databaseRows = 0;
  let databasePages = 0;
  const append = (records: UsageRecord[], record: UsageRecord | null) => {
    if (record === null || record.timestampMs < sinceMs) return;
    if (record.dedupeKey !== null) {
      if (seen.has(record.dedupeKey)) return;
      seen.add(record.dedupeKey);
    }
    records.push(record);
  };

  const databases = yield* fileSystem.readDirectory(root).pipe(
    Effect.flatMap((names) =>
      Effect.filter(
        names.filter((name) => /^opencode(?:-[a-zA-Z0-9_-]+)?\.db$/.test(name)),
        (name) =>
          entryInfo(path.join(root, name)).pipe(
            Effect.map((info) => info.type === "File"),
            Effect.catchTags({
              PlatformError: (cause) =>
                isNotFound(cause) ? Effect.succeed(false) : Effect.fail(cause),
            }),
          ),
      ),
    ),
    Effect.map((names) =>
      names.sort((a, b) =>
        a === "opencode.db" ? -1 : b === "opencode.db" ? 1 : a.localeCompare(b),
      ),
    ),
    Effect.catchTags({
      PlatformError: (cause) => {
        if (!isNotFound(cause)) error = true;
        return Effect.succeed([]);
      },
    }),
  );
  for (const name of databases) {
    found = true;
    const file = { path: path.join(root, name), records: [] as UsageRecord[] };
    files.push(file);
    // Taken before the snapshot opens, so a write that races the scan invalidates its rows.
    const [main, wal] = yield* Effect.forEach([file.path, `${file.path}-wal`], (target) =>
      Effect.option(fileSystem.stat(target)),
    );
    const stamp = (info: Option.Option<FileSystem.File.Info>) =>
      Option.match(info, {
        onNone: () => "none",
        onSome: (stat) => `${stat.size}:${Option.getOrNull(stat.mtime)?.getTime()}`,
      });
    // A replaced or restored database can repeat rowids and change markers, so every key includes
    // the main file; WAL commits leave it alone until a checkpoint.
    const identity = Option.match(main!, {
      onNone: () => "none",
      onSome: (stat) =>
        `${stat.dev}:${Option.getOrNull(stat.ino)}:${Option.getOrNull(stat.birthtime)?.getTime()}/${stamp(main!)}`,
    });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Fail promptly on live-writer locks instead of stalling the server.
      yield* sql.unsafe("PRAGMA busy_timeout = 100");
      const tables = new Set(
        (yield* sql.unsafe<{ readonly name: unknown }>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        )).map((row) => row.name),
      );
      if (!tables.has("message") && !tables.has("session_message")) error = true;
      for (const table of ["message", "session_message"] as const) {
        if (!tables.has(table)) continue;
        const columns = new Set(
          (yield* sql.unsafe<{ readonly name: unknown }>(`PRAGMA table_info(${table})`)).map(
            (row) => row.name,
          ),
        );
        const timestamp = columns.has("time_created") ? "time_created" : "NULL";
        const updated = columns.has("time_updated") ? "time_updated" : "NULL";
        // Without time_updated an in-place edit can keep the length, so any database write counts.
        const version = updated === "NULL" ? `${identity}/${stamp(wal!)}` : identity;
        const predicates = table === "session_message" ? ["type = 'assistant'"] : [];
        if (timestamp !== "NULL") predicates.push("time_created >= ?");
        // List rowids and change markers so SQLite can use time indexes without reading message
        // bodies; octet_length comes from the record header.
        const listed = (yield* sql.unsafe<{
          readonly row_id: number;
          readonly updated: unknown;
          readonly size: unknown;
          readonly created: unknown;
        }>(
          `SELECT rowid AS row_id, ${updated} AS updated, octet_length(data) AS size,
             ${timestamp} AS created
           FROM ${table}
           ${predicates.length ? `WHERE ${predicates.join(" AND ")}` : ""}`,
          timestamp === "NULL" ? [] : [sinceMs],
        )).toSorted((a, b) => a.row_id - b.row_id);
        databaseRows += listed.length;
        const key = `${file.path}\0${table}`;
        const previous = rowCache.get(key);
        const reusable = previous?.version === version ? previous.rows : undefined;
        const cached = new Map<number, CachedRow>();
        const misses: typeof listed = [];
        for (const row of listed) {
          const hit = reusable?.get(row.row_id);
          if (hit && hit.updated === row.updated && hit.size === row.size)
            cached.set(row.row_id, hit);
          else misses.push(row);
        }
        // Filter and project in SQLite: user diffs and assistant bodies can be hundreds of MB.
        const validAssistant = `CASE WHEN typeof(data) = 'text' AND json_valid(data)
          THEN json_type(data, '$.role') IS NULL OR data ->> '$.role' = 'assistant' END`;
        // Omit per-page spans; the enclosing scan records row and page counts.
        for (let start = 0; start < misses.length; start += MESSAGE_PAGE_SIZE) {
          const page = misses.slice(start, start + MESSAGE_PAGE_SIZE);
          databasePages++;
          const rows = yield* sql
            .unsafe<{
              readonly row_id: number;
              readonly id: unknown;
              readonly session_id: unknown;
              readonly data: unknown;
              readonly created: unknown;
            }>(
              `SELECT rowid AS row_id, id, session_id, ${timestamp} AS created, json_object(
                 'tokens', data -> '$.tokens', 'cost', data -> '$.cost',
                 'model', data -> '$.model', 'modelID', data -> '$.modelID',
                 'providerID', data -> '$.providerID',
                 'time', data -> '$.time', 'id', data -> '$.id', 'sessionID', data -> '$.sessionID'
               ) AS data
               FROM ${table}
               WHERE rowid IN (${page.map(() => "?").join(", ")}) AND ${validAssistant}
               ORDER BY rowid`,
              page.map((row) => row.row_id),
            )
            .pipe(Effect.withTracerEnabled(false));
          const parsed = new Map<number, UsageRecord | null>();
          for (const row of rows) {
            parsed.set(
              row.row_id,
              parseOpenCodeMessage(text(row.data), {
                id: text(row.id),
                sessionId: text(row.session_id),
                ...(typeof row.created === "number" ? { timestampMs: row.created } : {}),
              }),
            );
          }
          // Rows the SQL filter dropped are cached as empty so they are not read again either.
          for (const row of page) {
            cached.set(row.row_id, { ...row, record: parsed.get(row.row_id) ?? null });
          }
          yield* Effect.yieldNow;
        }
        for (const row of listed) append(file.records, cached.get(row.row_id)!.record);
        // Rows before this window were not listed; keep them for a wider window until retention.
        for (const [rowId, entry] of reusable ?? []) {
          const created = entry.created;
          if (typeof created === "number" && created < sinceMs && created >= retentionCutoffMs)
            cached.set(rowId, entry);
        }
        rowCache.set(key, { version, rows: cached });
      }
    }).pipe(
      (read) => Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(read)),
      // Run the scan on a reader worker so large databases do not block the server's event loop.
      NodeSqliteClient.readOnly,
      Effect.provide(
        NodeSqliteClient.layer({ filename: file.path, readonly: true, readerWorker: true }),
      ),
      Effect.catchTags({
        SqlError: () => {
          error = true;
          return Effect.void;
        },
      }),
    );
  }

  const directories = [path.join(root, "storage", "message")];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    yield* Effect.gen(function* () {
      const names = yield* fileSystem.readDirectory(directory);
      for (let start = 0; start < names.length; start += LEGACY_STAT_BATCH) {
        const batch = names.slice(start, start + LEGACY_STAT_BATCH);
        const entries = batch.map((name) => path.join(directory, name));
        // stat follows symlinks; avoid expensive readLink failures unless link identity matters.
        const infos = yield* Effect.forEach(
          entries,
          (entry) =>
            fileSystem.stat(entry).pipe(
              Effect.catchTags({
                PlatformError: (cause) =>
                  isNotFound(cause)
                    ? Effect.succeed(null)
                    : isSymbolicLink(entry).pipe(
                        Effect.flatMap((link) =>
                          link ? Effect.succeed(null) : Effect.fail(cause),
                        ),
                      ),
              }),
              Effect.exit,
            ),
          { concurrency: LEGACY_STAT_CONCURRENCY },
        );
        for (const [index, name] of batch.entries()) {
          const entry = entries[index]!;
          const info = yield* infos[index]!;
          if (info?.type === "Directory") {
            if (!(yield* isSymbolicLink(entry))) directories.push(entry);
          } else if (info?.type === "File" && name.endsWith(".json")) {
            const id = name.slice(0, -5);
            // Messages cannot postdate file mtime; older files hold no in-window usage.
            const skip =
              seen.has(`opencode:${id}`) ||
              Option.exists(info.mtime, (mtime) => mtime.getTime() < sinceMs);
            if (found && skip) continue;
            if (yield* isSymbolicLink(entry)) continue;
            found = true;
            if (skip) continue;
            const file = { path: entry, records: [] as UsageRecord[] };
            files.push(file);
            yield* fileSystem.readFileString(entry).pipe(
              Effect.map((source) => append(file.records, parseOpenCodeMessage(source, { id }))),
              Effect.catchTags({
                PlatformError: (cause) => {
                  if (!isNotFound(cause)) error = true;
                  return Effect.void;
                },
              }),
            );
          }
        }
      }
    }).pipe(
      Effect.catchTags({
        PlatformError: (cause) => {
          if (!isNotFound(cause)) error = true;
          return Effect.void;
        },
      }),
    );
  }
  yield* Effect.annotateCurrentSpan({
    "usage.database_rows": databaseRows,
    "usage.database_pages": databasePages,
  });
  return { files, missing: !found && !error, error };
}, scanLock.withPermit);

const resolveOpenCodeDataDirs = Effect.fn("resolveOpenCodeDataDirs")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const roots = environment["OPENCODE_DATA_DIR"]
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const dataHome = environment["XDG_DATA_HOME"]?.trim();
  const defaults = [
    path.join(
      dataHome && path.isAbsolute(dataHome)
        ? dataHome
        : path.join(homeDirectory, ".local", "share"),
      "opencode",
    ),
  ];
  const canonical = new Set<string>();
  for (const root of roots?.length ? roots : defaults) {
    const resolved = path.resolve(expandHomePath(root, homeDirectory));
    canonical.add(yield* fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved)));
  }
  return [...canonical];
});

export type OpenCodeUsageReaderEnv = FileSystem.FileSystem | Path.Path;

export const openCodeUsageReader: ProviderUsageReader<OpenCodeSettings, OpenCodeUsageReaderEnv> = {
  kind: "scan",
  provider: "opencode",
  scan: Effect.fn("openCodeUsageReader.scan")(function* ({
    instances,
    windowStartMs,
    retentionCutoffMs,
  }) {
    const roots = new Set<string>();
    for (const instance of instances) {
      for (const root of yield* resolveOpenCodeDataDirs(instance.environment)) roots.add(root);
    }
    return yield* Effect.forEach(
      roots,
      (dir) =>
        readOpenCodeUsage(dir, windowStartMs, retentionCutoffMs).pipe(
          Effect.map((result) => ({
            dir,
            files: result.missing && !result.error ? null : result.files,
            status: result.error ? ("partial" as const) : ("ok" as const),
            ...(result.error ? { message: "Some OpenCode history could not be read." } : {}),
          })),
        ),
      { concurrency: "unbounded" },
    );
  }),
};
