import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  tokenCount,
  type ProviderUsageReader,
  type UsageRecord,
  type UsageTokenRates,
} from "@t3tools/provider-core/server/usage";
import type { AcpRegistrySettings } from "../settings.ts";
import { acpRegistryManagedBinaryDirectories } from "./AcpRegistrySupport.ts";

const ModelCatalog = Schema.Struct({
  families: Schema.Array(
    Schema.Struct({
      variants: Schema.Array(
        Schema.Struct({
          model_uid: Schema.NonEmptyString,
          cost_summary: Schema.optionalKey(Schema.String),
          cost_tier: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
});
const decodeModelCatalog = Schema.decodeUnknownOption(ModelCatalog);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const Metrics = Schema.Struct({
  input_tokens: Schema.optionalKey(Schema.Unknown),
  output_tokens: Schema.optionalKey(Schema.Unknown),
  cache_read_tokens: Schema.optionalKey(Schema.Unknown),
  cache_creation_tokens: Schema.optionalKey(Schema.Unknown),
});
const decodeMessageUsage = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Tuple([
      Schema.Literal("assistant"),
      Schema.Unknown,
      Schema.Unknown,
      Schema.Unknown,
      Metrics,
    ]),
  ),
);

/** Devin's displayed model rates can differ from the model maker's API rates. */
export function parseDevinModelRates(document: unknown): ReadonlyMap<string, UsageTokenRates> {
  const decoded = decodeModelCatalog(document);
  const rates = new Map<string, UsageTokenRates>();
  if (Option.isNone(decoded)) return rates;
  for (const family of decoded.value.families) {
    for (const model of family.variants) {
      const fields = new Map<string, number>();
      for (const match of (model.cost_summary ?? "").matchAll(
        /\$([\d.]+)\s*\/\s*1M\s+(Cached input|Cache write|Input|Output)\b/giu,
      )) {
        const value = Number(match[1]);
        if (Number.isFinite(value) && value >= 0) fields.set(match[2]!.toLowerCase(), value / 1e6);
      }
      const input = fields.get("input");
      const output = fields.get("output");
      if (input !== undefined && output !== undefined) {
        rates.set(`devin/${model.model_uid}`, {
          inputCostPerToken: input,
          outputCostPerToken: output,
          cacheReadCostPerToken: fields.get("cached input") ?? input,
          cacheCreationCostPerToken: fields.get("cache write") ?? input,
        });
      } else if (model.cost_tier === "Free") {
        rates.set(`devin/${model.model_uid}`, {
          inputCostPerToken: 0,
          outputCostPerToken: 0,
          cacheReadCostPerToken: 0,
          cacheCreationCostPerToken: 0,
        });
      }
    }
  }
  return rates;
}

interface DevinUsageReadResult {
  readonly files: readonly { readonly path: string; readonly records: readonly UsageRecord[] }[];
  readonly missing: boolean;
  readonly error: boolean;
  readonly refreshing?: true;
}

export interface DevinUsageRow {
  readonly rowId: number;
  readonly nodeId: number;
  readonly requestId: string | null;
  readonly generationModel: string | null;
  readonly timestampMs: number;
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
}

export interface DevinSessionCache {
  readonly model: string;
  readonly lastActivityAt: number;
  readonly rowCount: number;
  readonly lastRowId: number;
  readonly rows: readonly DevinUsageRow[];
}

export interface DevinDirCache {
  readonly sequence: number;
  readonly sessions: ReadonlyMap<string, DevinSessionCache>;
}

const EMPTY_DIR_CACHE: DevinDirCache = { sequence: 0, sessions: new Map() };

const PAGE_SIZE = 512;

const DEVIN_USAGE_CACHE_FILE_NAME = "devin-usage-cache.json";

const PersistedRow = Schema.Tuple([
  Schema.Number,
  Schema.Number,
  Schema.NullOr(Schema.String),
  Schema.NullOr(Schema.String),
  Schema.Number,
  Schema.Number,
  Schema.Number,
  Schema.Number,
  Schema.Number,
]);
const PersistedSession = Schema.Struct({
  model: Schema.String,
  lastActivityAt: Schema.Number,
  rowCount: Schema.Number,
  lastRowId: Schema.Number,
  rows: Schema.Array(PersistedRow),
});
const PersistedDir = Schema.Struct({
  sequence: Schema.Number,
  sessions: Schema.Record(Schema.String, PersistedSession),
});
const PersistedFile = Schema.Struct({
  version: Schema.Literal(1),
  dirs: Schema.Record(Schema.String, PersistedDir),
});
const decodePersistedFile = Schema.decodeUnknownOption(Schema.fromJsonString(PersistedFile));

export function encodeDevinDirCaches(caches: ReadonlyMap<string, DevinDirCache>): string {
  const dirs: Record<string, typeof PersistedDir.Encoded> = {};
  for (const [dir, cache] of caches) {
    const sessions: Record<string, typeof PersistedSession.Encoded> = {};
    for (const [id, session] of cache.sessions) {
      sessions[id] = {
        model: session.model,
        lastActivityAt: session.lastActivityAt,
        rowCount: session.rowCount,
        lastRowId: session.lastRowId,
        rows: session.rows.map((row): typeof PersistedRow.Encoded => [
          row.rowId,
          row.nodeId,
          row.requestId,
          row.generationModel,
          row.timestampMs,
          row.input,
          row.cacheRead,
          row.cacheWrite,
          row.output,
        ]),
      };
    }
    dirs[dir] = { sequence: cache.sequence, sessions };
  }
  return JSON.stringify({ version: 1, dirs });
}

export function decodeDevinDirCaches(contents: string): Map<string, DevinDirCache> {
  const caches = new Map<string, DevinDirCache>();
  const decoded = decodePersistedFile(contents);
  if (Option.isNone(decoded)) return caches;
  for (const [dir, raw] of Object.entries(decoded.value.dirs)) {
    const sessions = new Map<string, DevinSessionCache>();
    for (const [id, session] of Object.entries(raw.sessions)) {
      sessions.set(id, {
        model: session.model,
        lastActivityAt: session.lastActivityAt,
        rowCount: session.rowCount,
        lastRowId: session.lastRowId,
        rows: session.rows.map(
          ([
            rowId,
            nodeId,
            requestId,
            generationModel,
            timestampMs,
            input,
            cacheRead,
            cacheWrite,
            output,
          ]) => ({
            rowId,
            nodeId,
            requestId,
            generationModel,
            timestampMs,
            input,
            cacheRead,
            cacheWrite,
            output,
          }),
        ),
      });
    }
    caches.set(dir, { sequence: raw.sequence, sessions });
  }
  return caches;
}

const assembleDevinUsage = (input: {
  readonly filename: string;
  readonly sinceMs: number;
  readonly cache: DevinDirCache;
  readonly error?: boolean | undefined;
}): DevinUsageReadResult => {
  const files: Array<{ path: string; records: UsageRecord[] }> = [];
  const seen = new Set<string>();
  const eligibleAt = Math.floor(input.sinceMs / 1000);
  const sessions = [...input.cache.sessions.entries()]
    .filter(([, session]) => session.lastActivityAt >= eligibleAt)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [sessionId, session] of sessions) {
    if (session.rowCount === 0) continue;
    const records: UsageRecord[] = [];
    files.push({ path: `${input.filename}:${sessionId}`, records });
    for (const row of [...session.rows].sort((a, b) => a.nodeId - b.nodeId)) {
      if (row.timestampMs < input.sinceMs) continue;
      const model = row.generationModel ?? session.model;
      if (!model) continue;
      const dedupeKey =
        row.requestId !== null ? `devin:${row.requestId}` : `devin:${sessionId}:${row.nodeId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      records.push({
        provider: "devin",
        timestampMs: row.timestampMs,
        model,
        rateModel: `devin/${model}`,
        sessionId,
        totals: {
          uncachedInputTokens: row.input,
          cachedInputTokens: row.cacheRead,
          cacheCreationTokens: row.cacheWrite,
          outputTokens: row.output,
          reasoningTokens: 0,
        },
        reportedCostUsd: null,
        speed: "standard",
        dedupeKey,
      });
    }
  }
  return { files, missing: false, error: input.error === true };
};

interface DevinUsageRead {
  readonly result: DevinUsageReadResult;
  readonly cache: DevinDirCache;
  readonly rowsRead: number;
}

/** Project usage fields in SQLite so conversation text and tool results never enter the collector. */
export const readDevinUsage = Effect.fn("DevinUsage.read")(function* (input: {
  readonly dir: string;
  readonly sinceMs: number;
  readonly cache?: DevinDirCache | undefined;
  readonly onProgress?: (cache: DevinDirCache) => Effect.Effect<void>;
}): Effect.fn.Return<DevinUsageRead, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filename = path.join(input.dir, "sessions.db");
  const exists = yield* fs.exists(filename).pipe(Effect.orElseSucceed(() => true));
  if (!exists) {
    return {
      result: { files: [], missing: true, error: false },
      cache: input.cache ?? EMPTY_DIR_CACHE,
      rowsRead: 0,
    };
  }
  const sessions = new Map(input.cache?.sessions ?? []);
  let sequence = input.cache?.sequence ?? 0;
  let rowsRead = 0;
  const read = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA busy_timeout=100");
    const [sequenceRow] = yield* sql.unsafe<{ seq: number }>(
      "SELECT seq FROM sqlite_sequence WHERE name='message_nodes'",
    );
    sequence = sequenceRow?.seq ?? 0;
    if (input.cache !== undefined && sequence < input.cache.sequence) sessions.clear();
    const sessionRows = yield* sql.unsafe<{
      id: string;
      model: string | null;
      last_activity_at: number | null;
    }>("SELECT id, model, last_activity_at FROM sessions ORDER BY id");
    const stats = new Map(
      (yield* sql.unsafe<{ session_id: string; row_count: number; last_row_id: number | null }>(
        "SELECT session_id, count(*) AS row_count, max(row_id) AS last_row_id FROM message_nodes INDEXED BY idx_message_nodes_session GROUP BY session_id",
      )).map((row) => [row.session_id, row] as const),
    );
    const live = new Set(sessionRows.map((session) => session.id));
    for (const id of sessions.keys()) {
      const stat = stats.get(id);
      if (!live.has(id) || stat === undefined || stat.row_count === 0) sessions.delete(id);
    }
    const eligibleAt = Math.floor(input.sinceMs / 1000);
    // Finish small sessions first so a large conversation cannot hide all initial results.
    const ordered = sessionRows.toSorted(
      (a, b) => (stats.get(a.id)?.row_count ?? 0) - (stats.get(b.id)?.row_count ?? 0),
    );
    let completedSessions = 0;
    for (const [index, session] of ordered.entries()) {
      const lastActivityAt = session.last_activity_at ?? 0;
      if (lastActivityAt < eligibleAt) continue;
      const stat = stats.get(session.id);
      const rowCount = stat?.row_count ?? 0;
      const lastRowId = stat?.last_row_id ?? 0;
      if (rowCount === 0) {
        sessions.delete(session.id);
        continue;
      }
      const cached = sessions.get(session.id);
      if (cached !== undefined && cached.rowCount === rowCount && cached.lastRowId === lastRowId) {
        sessions.set(session.id, { ...cached, model: session.model ?? "", lastActivityAt });
        continue;
      }
      const refreshed = yield* sql.withTransaction(
        Effect.gen(function* () {
          const [inner] = yield* sql.unsafe<{
            row_count: number;
            last_row_id: number | null;
          }>(
            "SELECT count(*) AS row_count, max(row_id) AS last_row_id FROM message_nodes WHERE session_id=?",
            [session.id],
          );
          const count = inner?.row_count ?? 0;
          const last = inner?.last_row_id ?? 0;
          const fetched: DevinUsageRow[] = [];
          let fetchedCount = 0;
          let after = cached?.lastRowId ?? 0;
          while (after < last) {
            const rows = yield* sql
              .unsafe<{
                row_id: number;
                node_id: number;
                created_at: number;
                usage: unknown;
              }>(
                // Current Devin messages put message_id before role; older exports start with role.
                `SELECT row_id, node_id, created_at,
                 CASE WHEN chat_message GLOB '{"role":"[tus]*'
                        OR chat_message GLOB '{"message_id":"????????-????-????-????-????????????","role":"[tus]*'
                        OR chat_message GLOB '{"message_id":null,"role":"[tus]*' THEN NULL
                   WHEN json_valid(chat_message) THEN json_extract(chat_message,
                   '$.role', '$.metadata.request_id', '$.metadata.generation_model',
                   '$.metadata.created_at', '$.metadata.metrics') END AS usage
                 FROM message_nodes WHERE session_id=? AND row_id>? AND row_id<=?
                 ORDER BY row_id LIMIT ?`,
                [session.id, after, last, PAGE_SIZE],
              )
              .pipe(Effect.withTracerEnabled(false));
            if (rows.length === 0) break;
            for (const row of rows) {
              after = row.row_id;
              fetchedCount++;
              const decoded = decodeMessageUsage(row.usage);
              if (Option.isNone(decoded)) continue;
              const [, requestId, generationModel, timestamp, metrics] = decoded.value;
              const timestampMs =
                typeof timestamp === "string" ? Date.parse(timestamp) : row.created_at * 1000;
              if (!Number.isFinite(timestampMs)) continue;
              const input = tokenCount(metrics.input_tokens);
              const cacheRead = tokenCount(metrics.cache_read_tokens);
              const cacheWrite = tokenCount(metrics.cache_creation_tokens);
              const output = tokenCount(metrics.output_tokens);
              if (input + cacheRead + cacheWrite + output === 0) continue;
              fetched.push({
                rowId: row.row_id,
                nodeId: row.node_id,
                requestId: typeof requestId === "string" && requestId.length > 0 ? requestId : null,
                generationModel:
                  typeof generationModel === "string" && generationModel.length > 0
                    ? generationModel
                    : null,
                timestampMs,
                input,
                cacheRead,
                cacheWrite,
                output,
              });
            }
            yield* Effect.yieldNow;
          }
          let merged = cached?.rows ?? [];
          if ((cached?.rowCount ?? 0) + fetchedCount !== count) {
            const liveIds = new Set(
              (yield* sql
                .unsafe<{ row_id: number }>(
                  "SELECT row_id FROM message_nodes WHERE session_id=? AND row_id<=?",
                  [session.id, last],
                )
                .pipe(Effect.withTracerEnabled(false))).map((row) => row.row_id),
            );
            merged = merged.filter((row) => liveIds.has(row.rowId));
          }
          if (fetched.length > 0) {
            const byNode = new Map(merged.map((row) => [row.nodeId, row] as const));
            for (const row of fetched) byNode.set(row.nodeId, row);
            merged = [...byNode.values()].sort((a, b) => a.nodeId - b.nodeId);
          }
          return {
            session: {
              model: session.model ?? "",
              lastActivityAt,
              rowCount: count,
              lastRowId: last,
              rows: merged,
            } satisfies DevinSessionCache,
            rowsRead: fetchedCount,
          };
        }),
      );
      sessions.set(session.id, refreshed.session);
      rowsRead += refreshed.rowsRead;
      completedSessions++;
      if (
        input.onProgress !== undefined &&
        index < ordered.length - 1 &&
        (completedSessions === 1 || completedSessions % 8 === 0)
      ) {
        yield* input.onProgress({ sequence, sessions: new Map(sessions) });
      }
    }
  }).pipe(
    NodeSqliteClient.readOnly,
    Effect.provide(NodeSqliteClient.layer({ filename, readonly: true, readerWorker: true })),
  );
  const error = yield* read.pipe(
    Effect.as(false),
    Effect.catchTags({ SqlError: () => Effect.succeed(true) }),
  );
  const cache: DevinDirCache = { sequence, sessions };
  yield* Effect.annotateCurrentSpan("rowsRead", rowsRead);
  return {
    result: assembleDevinUsage({ filename, sinceMs: input.sinceMs, cache, error }),
    cache,
    rowsRead,
  };
});

export class DevinUsage extends Context.Service<
  DevinUsage,
  {
    readonly history: (input: {
      readonly dir: string;
      readonly sinceMs: number;
      readonly awaitRefresh: boolean;
    }) => Effect.Effect<DevinUsageReadResult>;
    readonly prices: (input: {
      readonly command: string;
      readonly environment: NodeJS.ProcessEnv;
    }) => Effect.Effect<ReadonlyMap<string, UsageTokenRates>>;
    readonly awaitPersisted: Effect.Effect<void>;
  }
>()("@t3tools/provider-acp-registry/server/devinUsage") {}

interface DirEntry {
  readonly cache: DevinDirCache;
  readonly fingerprint: string | null;
  readonly coveredSinceMs: number;
  readonly error: boolean;
  readonly retryAtMs: number;
  readonly assembled: Map<number, DevinUsageReadResult>;
}

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Scope.Scope;
  const host = yield* ProviderHost.ProviderHost;
  const cachePath = path.join(host.paths.stateDir, DEVIN_USAGE_CACHE_FILE_NAME);
  const dirs = new Map<string, DirEntry>();
  const scans = new Map<
    string,
    {
      readonly sinceMs: number;
      changed: Deferred.Deferred<void>;
    }
  >();

  const ensureLoaded = yield* Effect.cached(
    fs.readFileString(cachePath).pipe(
      Effect.map((raw) => {
        for (const [dir, cache] of decodeDevinDirCaches(raw)) {
          if (!dirs.has(dir)) {
            dirs.set(dir, {
              cache,
              fingerprint: null,
              coveredSinceMs: Number.POSITIVE_INFINITY,
              error: false,
              retryAtMs: 0,
              assembled: new Map(),
            });
          }
        }
      }),
      Effect.ignoreCause,
    ),
  );

  let cacheDirty = false;
  const persistLock = yield* Semaphore.make(1);
  const persist = Effect.gen(function* () {
    if (!cacheDirty) return;
    cacheDirty = false;
    yield* Effect.sync(() =>
      encodeDevinDirCaches(new Map([...dirs].map(([dir, entry]) => [dir, entry.cache] as const))),
    ).pipe(
      Effect.flatMap((contents) => writeFileStringAtomically({ filePath: cachePath, contents })),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.catchCause(() =>
        Effect.sync(() => {
          cacheDirty = true;
        }),
      ),
    );
  }).pipe(persistLock.withPermit, Effect.withSpan("DevinUsage.persist"));

  const pendingPersists = new Set<Fiber.Fiber<void>>();
  const schedulePersist = Effect.forkDetach(persist).pipe(
    Effect.map((fiber) => {
      pendingPersists.add(fiber);
      fiber.addObserver(() => pendingPersists.delete(fiber));
    }),
  );
  const awaitPersisted = Effect.suspend(() => Fiber.awaitAll([...pendingPersists])).pipe(
    Effect.asVoid,
  );
  yield* Effect.addFinalizer(() => awaitPersisted);

  const assembleFor = (entry: DirEntry, filename: string, sinceMs: number) => {
    let result = entry.assembled.get(sinceMs);
    if (result === undefined) {
      result = assembleDevinUsage({ filename, sinceMs, cache: entry.cache, error: entry.error });
      if (entry.assembled.size >= 4) entry.assembled.clear();
      entry.assembled.set(sinceMs, result);
    }
    return result;
  };

  const history: DevinUsage["Service"]["history"] = Effect.fn("DevinUsage.history")(
    function* (input) {
      const filename = path.join(input.dir, "sessions.db");
      if (!(yield* fs.exists(filename).pipe(Effect.orElseSucceed(() => true)))) {
        return { files: [], missing: true, error: false };
      }
      yield* ensureLoaded;
      const fingerprint = encodeJson(
        yield* Effect.forEach([filename, `${filename}-wal`], (file) =>
          fs.stat(file).pipe(
            Effect.map((info) => [
              Number(info.size),
              Option.getOrNull(Option.map(info.mtime, (date) => date.getTime())),
            ]),
            Effect.orElseSucceed(() => null),
          ),
        ),
      );
      const entry = dirs.get(input.dir);
      const now = yield* Clock.currentTimeMillis;
      if (
        entry !== undefined &&
        entry.fingerprint === fingerprint &&
        entry.coveredSinceMs <= input.sinceMs &&
        (!entry.error || now < entry.retryAtMs)
      ) {
        return assembleFor(entry, filename, input.sinceMs);
      }
      const stale = () => ({
        ...(entry === undefined
          ? { files: [], missing: false, error: false }
          : assembleFor(entry, filename, input.sinceMs)),
        refreshing: true as const,
      });
      const active = scans.get(input.dir);
      if (active !== undefined) {
        if (input.awaitRefresh) {
          yield* Deferred.await(active.changed);
          const latest = dirs.get(input.dir);
          if (scans.has(input.dir)) {
            return {
              ...(latest === undefined ? stale() : assembleFor(latest, filename, input.sinceMs)),
              refreshing: true as const,
            };
          }
          if (active.sinceMs > input.sinceMs) return yield* history(input);
          return latest === undefined ? stale() : assembleFor(latest, filename, input.sinceMs);
        }
        return stale();
      }
      const scan = { sinceMs: input.sinceMs, changed: yield* Deferred.make<void>() };
      scans.set(input.dir, scan);
      yield* readDevinUsage({
        dir: input.dir,
        sinceMs: input.sinceMs,
        cache: entry?.cache,
        onProgress: Effect.fn("DevinUsage.publishProgress")(function* (cache) {
          dirs.set(input.dir, {
            cache,
            fingerprint: null,
            coveredSinceMs: Number.POSITIVE_INFINITY,
            error: false,
            retryAtMs: 0,
            assembled: new Map(),
          });
          cacheDirty = true;
          yield* schedulePersist;
          const changed = scan.changed;
          scan.changed = yield* Deferred.make<void>();
          yield* Deferred.succeed(changed, undefined);
        }),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            let result: DevinUsageReadResult;
            let cache = dirs.get(input.dir)?.cache ?? entry?.cache ?? EMPTY_DIR_CACHE;
            let error = false;
            if (Exit.isSuccess(exit)) {
              cache = exit.value.cache;
              error = exit.value.result.error;
              result = exit.value.result;
            } else {
              error = true;
              result = assembleDevinUsage({
                filename,
                sinceMs: input.sinceMs,
                cache,
                error: true,
              });
            }
            if (dirs.size >= 8 && !dirs.has(input.dir)) {
              dirs.delete(dirs.keys().next().value ?? "");
            }
            dirs.set(input.dir, {
              cache,
              fingerprint,
              coveredSinceMs: input.sinceMs,
              error,
              retryAtMs: now + 30_000,
              assembled: new Map([[input.sinceMs, result]]),
            });
            if (Exit.isSuccess(exit)) {
              cacheDirty = true;
              yield* schedulePersist;
            }
            scans.delete(input.dir);
            yield* Deferred.succeed(scan.changed, undefined);
          }),
        ),
        Effect.forkIn(scope),
      );
      return input.awaitRefresh ? yield* history(input) : stale();
    },
  );
  const lock = yield* Semaphore.make(1);
  const cached = new Map<
    string,
    { expiresAt: number; rates: ReadonlyMap<string, UsageTokenRates> }
  >();
  const prices: DevinUsage["Service"]["prices"] = Effect.fn("DevinUsage.prices")(function* ({
    command,
    environment,
  }) {
    const key = encodeJson([
      command,
      Object.entries(environment).sort(([a], [b]) => a.localeCompare(b)),
    ]);
    const now = yield* Clock.currentTimeMillis;
    const previous = cached.get(key);
    if (previous && previous.expiresAt > now) return previous.rates;
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const resolved = yield* resolveSpawnCommand(
          command,
          ["models", "list", "--format", "json"],
          { env: environment },
        );
        const child = yield* spawner.spawn(
          ChildProcess.make(resolved.command, resolved.args, {
            env: environment,
            shell: resolved.shell,
          }),
        );
        const [stdout, , code] = yield* Effect.all(
          [
            collectUint8StreamText({ stream: child.stdout, maxBytes: 1024 * 1024 }),
            collectUint8StreamText({ stream: child.stderr, maxBytes: 4096 }),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        if (Number(code) !== 0 || stdout.truncated) return undefined;
        const decoded = decodeJson(stdout.text);
        return Option.isSome(decoded) ? parseDevinModelRates(decoded.value) : undefined;
      }),
    ).pipe(
      Effect.timeoutOption("10 seconds"),
      Effect.orElseSucceed(() => Option.none()),
    );
    const fresh = Option.isSome(result) ? result.value : undefined;
    const rates = fresh?.size ? fresh : (previous?.rates ?? new Map<string, UsageTokenRates>());
    if (cached.size >= 32 && !cached.has(key)) cached.delete(cached.keys().next().value ?? "");
    cached.set(key, { expiresAt: now + (fresh?.size ? 15 * 60_000 : 30_000), rates });
    return rates;
  }, lock.withPermit);
  return DevinUsage.of({ history, prices, awaitPersisted });
});

export const layer = Layer.effect(DevinUsage, make);

export type DevinUsageReaderEnv =
  | FileSystem.FileSystem
  | Path.Path
  | ProviderHost.ProviderHost
  | DevinUsage;

export const devinUsageReader = {
  kind: "scan",
  provider: "devin",
  scan: Effect.fn("DevinUsage.scan")(function* ({ instances, windowStartMs, awaitRefresh }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const platform = yield* HostProcess.Platform;
    const architecture = yield* HostProcess.Architecture;
    const host = yield* ProviderHost.ProviderHost;
    const usage = yield* DevinUsage;
    const roots = new Map<string, { command: string; environment: NodeJS.ProcessEnv }>();
    for (const { config, environment, configured } of instances) {
      if (configured && !(config?.source === "registry" && config.agentId === "devin")) continue;
      const dataHome =
        environment.XDG_DATA_HOME ||
        (platform === "win32" ? environment.APPDATA : undefined) ||
        path.join(environment.HOME || environment.USERPROFILE || home, ".local", "share");
      const dir = path.join(expandHomePath(dataHome, home), "devin", "cli");
      const canonical = yield* fs.realPath(dir).pipe(Effect.orElseSucceed(() => dir));
      if (roots.has(canonical)) continue;
      let command = config?.commandPath || "devin";
      if (
        command === "devin" &&
        (yield* fs.exists(path.join(dir, "sessions.db")).pipe(Effect.orElseSucceed(() => false)))
      ) {
        const directories = yield* acpRegistryManagedBinaryDirectories({
          cacheDir: host.paths.providerStatusCacheDir,
          toolsDir: path.join(host.paths.baseDir, "tools"),
          platform,
          architecture,
        });
        for (const directory of directories) {
          const candidate = path.join(directory, platform === "win32" ? "devin.exe" : "devin");
          if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
            command = candidate;
            break;
          }
        }
      }
      roots.set(canonical, { command: expandHomePath(command, home), environment });
    }
    return yield* Effect.forEach(
      roots,
      ([dir, input]) =>
        Effect.gen(function* () {
          const result = yield* usage.history({ dir, sinceMs: windowStartMs, awaitRefresh });
          const modelRates =
            result.missing || (result.refreshing && result.files.length === 0)
              ? undefined
              : yield* usage.prices(input);
          return {
            dir,
            files: result.missing ? null : result.files,
            status: result.error ? ("partial" as const) : ("ok" as const),
            ...(result.refreshing ? { refreshing: true as const } : {}),
            ...(modelRates === undefined ? {} : { modelRates }),
            ...(result.error ? { message: "Some Devin history could not be read." } : {}),
          };
        }),
      { concurrency: 2 },
    );
  }),
} satisfies ProviderUsageReader<AcpRegistrySettings, DevinUsageReaderEnv>;
