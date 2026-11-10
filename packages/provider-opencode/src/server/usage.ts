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
  return {
    provider: "opencode",
    timestampMs,
    model,
    sessionId: fallback.sessionId || text(message.sessionID),
    totals,
    // OpenCode uses zero for unknown rates, including paid subscriptions; let shared pricing estimate.
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null,
    speed: "standard",
    recordCount: 1,
    dedupeKey: id ? `opencode:${id}` : null,
  };
}

export interface OpenCodeUsageReadResult {
  readonly files: readonly { readonly path: string; readonly records: readonly UsageRecord[] }[];
  readonly missing: boolean;
  readonly error: boolean;
}

const isNotFound = (cause: PlatformError.PlatformError) => cause.reason._tag === "NotFound";
const MESSAGE_PAGE_SIZE = 64;

const isSymbolicLink = Effect.fnUntraced(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* Effect.isSuccess(fileSystem.readLink(path));
});

/** Which OpenCode databases a read covers, mirroring OpenCode's own environment switches. */
export interface OpenCodeDatabaseSelection {
  /**
   * The database `OPENCODE_DB` names, already resolved; `null` for an
   * in-memory database, which keeps no history. When set, only this database
   * is read.
   */
  readonly databasePath?: string | null;
  /** Read channel databases (`opencode-<channel>.db`) beside `opencode.db`. Defaults to true. */
  readonly channelDatabases?: boolean;
}

/** Stat of a regular file or directory; a symlink reports as itself and is never followed. */
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
  selection: OpenCodeDatabaseSelection = {},
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

  const explicitDatabase = selection.databasePath;
  const channelDatabases = selection.channelDatabases ?? true;
  const listedDatabases = fileSystem.readDirectory(root).pipe(
    Effect.flatMap((names) =>
      Effect.filter(
        names.filter((name) =>
          channelDatabases
            ? /^opencode(?:-[a-zA-Z0-9_-]+)?\.db$/.test(name)
            : name === "opencode.db",
        ),
        // One database removed between listing and stat must not hide the rest.
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
      names
        .sort((a, b) => (a === "opencode.db" ? -1 : b === "opencode.db" ? 1 : a.localeCompare(b)))
        .map((name) => path.join(root, name)),
    ),
    Effect.catchTags({
      PlatformError: (cause) => {
        if (!isNotFound(cause)) error = true;
        return Effect.succeed([]);
      },
    }),
  );
  // `OPENCODE_DB` names one database; an in-memory one keeps no history.
  const databases =
    explicitDatabase === undefined
      ? yield* listedDatabases
      : explicitDatabase === null
        ? []
        : yield* entryInfo(explicitDatabase).pipe(
            Effect.map((info) => (info.type === "File" ? [explicitDatabase] : [])),
            Effect.catchTags({
              PlatformError: (cause) => {
                if (!isNotFound(cause)) error = true;
                return Effect.succeed([]);
              },
            }),
          );
  for (const databasePath of databases) {
    found = true;
    const file = { path: databasePath, records: [] as UsageRecord[] };
    files.push(file);
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
        const predicates = table === "session_message" ? ["type = 'assistant'"] : [];
        if (timestamp !== "NULL") predicates.push("time_created >= ?");
        // List only rowids so SQLite can use time indexes without reading message bodies.
        const listed = (yield* sql.unsafe<{ readonly row_id: number }>(
          `SELECT rowid AS row_id FROM ${table}
           ${predicates.length ? `WHERE ${predicates.join(" AND ")}` : ""}`,
          timestamp === "NULL" ? [] : [sinceMs],
        )).toSorted((a, b) => a.row_id - b.row_id);
        databaseRows += listed.length;
        // Filter and project in SQLite: user diffs and assistant bodies can be hundreds of MB.
        const validAssistant = `CASE WHEN typeof(data) = 'text' AND json_valid(data)
          THEN json_type(data, '$.role') IS NULL OR data ->> '$.role' = 'assistant' END`;
        // Omit per-page spans; the enclosing scan records row and page counts.
        for (let start = 0; start < listed.length; start += MESSAGE_PAGE_SIZE) {
          const page = listed.slice(start, start + MESSAGE_PAGE_SIZE);
          databasePages++;
          const rows = yield* sql
            .unsafe<{
              readonly id: unknown;
              readonly session_id: unknown;
              readonly data: unknown;
              readonly created: unknown;
            }>(
              `SELECT id, session_id, ${timestamp} AS created, json_object(
                 'tokens', data -> '$.tokens', 'cost', data -> '$.cost',
                 'model', data -> '$.model', 'modelID', data -> '$.modelID',
                 'time', data -> '$.time', 'id', data -> '$.id', 'sessionID', data -> '$.sessionID'
               ) AS data
               FROM ${table}
               WHERE rowid IN (${page.map(() => "?").join(", ")}) AND ${validAssistant}
               ORDER BY rowid`,
              page.map((row) => row.row_id),
            )
            .pipe(Effect.withTracerEnabled(false));
          for (const row of rows) {
            append(
              file.records,
              parseOpenCodeMessage(text(row.data), {
                id: text(row.id),
                sessionId: text(row.session_id),
                ...(typeof row.created === "number" ? { timestampMs: row.created } : {}),
              }),
            );
          }
          yield* Effect.yieldNow;
        }
      }
    }).pipe(
      (read) => Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(read)),
      Effect.provide(NodeSqliteClient.layer({ filename: file.path, readonly: true })),
      Effect.catchTags({
        SqlError: () => {
          error = true;
          return Effect.void;
        },
      }),
    );
  }

  // An explicit database replaces the data directory's stores entirely.
  if (explicitDatabase !== undefined) return { files, missing: !found && !error, error };

  // Do not follow symlinks, including cycles. Database records win over their
  // old JSON copies when OpenCode has migrated a store in place.
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
});

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
  scan: Effect.fn("openCodeUsageReader.scan")(function* ({ instances, windowStartMs }) {
    const path = yield* Path.Path;
    type Source = { readonly dir: string; readonly selection: OpenCodeDatabaseSelection };
    const sources = new Map<string, Source>();
    for (const instance of instances) {
      const environment = instance.environment;
      const roots = yield* resolveOpenCodeDataDirs(environment);
      // OpenCode's own switches: `OPENCODE_DB` names one database (relative to
      // the data directory), and `OPENCODE_DISABLE_CHANNEL_DB` keeps it on
      // `opencode.db` without per-channel databases.
      const databaseOverride = environment["OPENCODE_DB"]?.trim();
      const channelDatabases = !["1", "true"].includes(
        environment["OPENCODE_DISABLE_CHANNEL_DB"]?.trim().toLowerCase() ?? "",
      );
      const instanceSources: ReadonlyArray<Source> = databaseOverride
        ? roots.slice(0, 1).map((root) => {
            const databasePath =
              databaseOverride === ":memory:"
                ? null
                : path.isAbsolute(databaseOverride)
                  ? databaseOverride
                  : path.join(root, databaseOverride);
            return {
              dir: databasePath === null ? root : path.dirname(databasePath),
              selection: { databasePath },
            };
          })
        : roots.map((root) => ({ dir: root, selection: { channelDatabases } }));
      for (const source of instanceSources) {
        const { databasePath, channelDatabases: channels } = source.selection;
        sources.set(`${source.dir}\0${String(databasePath)}\0${String(channels)}`, source);
      }
    }
    return yield* Effect.forEach(
      sources.values(),
      ({ dir, selection }) =>
        readOpenCodeUsage(dir, windowStartMs, selection).pipe(
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
