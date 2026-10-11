/**
 * Usage history for OpenCode, read from its SQLite databases and legacy JSON
 * message store under each data directory.
 *
 * @module provider-opencode/server/usage
 */

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

/** OpenCode stores uncached input and reasoning separately from input/output. */
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
    // OpenCode writes zero for models without a known rate, including paid
    // subscription models. Let the shared price table estimate those records.
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null,
    speed: "standard",
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

/** Whether the path is itself a symlink, without following it. */
const isSymbolicLink = Effect.fnUntraced(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* Effect.isSuccess(fileSystem.readLink(path));
});

/** Stat of a regular file or directory; a symlink reports as itself and is never followed. */
const entryInfo = Effect.fn("entryInfo")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  if (yield* isSymbolicLink(path))
    return { type: "SymbolicLink" as const, mtime: Option.none<Date>() };
  return yield* fileSystem.stat(path);
});

/**
 * Stats run in the libuv thread pool, so a few at a time cut the walk's wall
 * time without lengthening any event-loop turn.
 */
const LEGACY_STAT_CONCURRENCY = 4;

/** Entries stat'd before any is processed, so one huge directory is not held in memory at once. */
const LEGACY_STAT_BATCH = 256;

/** Reads current SQLite and pre-migration JSON stores without modifying either. */
export const readOpenCodeUsage = Effect.fn("readOpenCodeUsage")(function* (
  root: string,
  sinceMs: number,
): Effect.fn.Return<OpenCodeUsageReadResult, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: { path: string; records: UsageRecord[] }[] = [];
  const seen = new Set<string>();
  let found = false;
  let error = false;
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
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // A busy live provider should fail this source promptly rather than
      // stalling the server while SQLite waits for its writer.
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
        const lastRowId = (yield* sql.unsafe<{ readonly last_row_id: number | null }>(
          `SELECT MAX(rowid) AS last_row_id FROM ${table}`,
        ))[0]?.last_row_id;
        if (lastRowId === null || lastRowId === undefined) continue;
        let afterRowId: number | undefined;
        // SqlClient materializes each result with StatementSync.all(). Keep
        // message bodies in small pages, and exclude rows appended mid-scan.
        while (true) {
          const pagePredicates = [
            ...predicates,
            "rowid <= ?",
            ...(afterRowId === undefined ? [] : ["rowid > ?"]),
          ];
          const rows = yield* sql.unsafe<{
            readonly row_id: number;
            readonly id: unknown;
            readonly session_id: unknown;
            readonly data: unknown;
            readonly created: unknown;
          }>(
            `SELECT rowid AS row_id, id, session_id, data, ${timestamp} AS created
             FROM ${table} WHERE ${pagePredicates.join(" AND ")} ORDER BY rowid LIMIT ${MESSAGE_PAGE_SIZE}`,
            [
              ...(timestamp === "NULL" ? [] : [sinceMs]),
              lastRowId,
              ...(afterRowId === undefined ? [] : [afterRowId]),
            ],
          );
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
          if (rows.length < MESSAGE_PAGE_SIZE) break;
          afterRowId = rows[rows.length - 1]!.row_id;
          yield* Effect.yieldNow;
        }
      }
    }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: file.path, readonly: true })),
      Effect.catchTags({
        SqlError: () => {
          error = true;
          return Effect.void;
        },
      }),
    );
  }

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
        // `stat` follows symlinks and `readLink` fails, expensively, for
        // everything else. Stat a batch, then ask whether an entry is a symlink
        // only where the answer changes the result.
        const infos = yield* Effect.forEach(
          entries,
          (entry) =>
            fileSystem.stat(entry).pipe(
              Effect.catchTags({
                // A symlink whose target cannot be stat'd is skipped, not an error.
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
            // A message cannot be created after its file was last written, so a
            // file untouched since the window opened holds nothing in range.
            const skip =
              seen.has(`opencode:${id}`) ||
              Option.exists(info.mtime, (mtime) => mtime.getTime() < sinceMs);
            // A skipped file only matters as proof that the store exists.
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
  return { files, missing: !found && !error, error };
});

/**
 * The data directories to read: `OPENCODE_DATA_DIR` (comma-separated) or the
 * XDG default, canonicalized so aliases count once.
 */
const resolveOpenCodeDataDirs = Effect.fn("resolveOpenCodeDataDirs")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
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
  scan: Effect.fn("openCodeUsageReader.scan")(function* ({ windowStartMs }) {
    const roots = yield* resolveOpenCodeDataDirs();
    return yield* Effect.forEach(
      roots,
      (dir) =>
        readOpenCodeUsage(dir, windowStartMs).pipe(
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
