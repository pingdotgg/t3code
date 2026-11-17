#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - copyFile is the only FICLONE file copy on Linux.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import { resolveWorktreeT3Home } from "@t3tools/shared/devHome";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Command, Flag } from "effect/cli";

import * as ProjectionStore from "../src/orchestration-v2/ProjectionStore.ts";
import * as CheckoutCloner from "../src/vcs/CheckoutCloner.ts";
import { rebuildMessageSearch } from "../src/orchestration-v2/messageSearchIndex.ts";
import {
  forkMigrationManifest,
  hasPendingMigrations,
  migrationManifest,
  runMigrations,
} from "../src/persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

export class MigrateDevDbNotInWorktreeError extends Schema.TaggedError<MigrateDevDbNotInWorktreeError>()(
  "MigrateDevDbNotInWorktreeError",
  {},
) {
  override get message(): string {
    return "Not inside a linked git worktree. Pass --base-dir to target an isolated .t3 directory.";
  }
}

export class MigrateDevDbSharedHomeError extends Schema.TaggedError<MigrateDevDbSharedHomeError>()(
  "MigrateDevDbSharedHomeError",
  {},
) {
  override get message(): string {
    return "Refusing to rebuild the shared ~/.t3 database. Use an isolated --base-dir.";
  }
}

export class MigrateDevDbSourceMissingError extends Schema.TaggedError<MigrateDevDbSourceMissingError>()(
  "MigrateDevDbSourceMissingError",
  {
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Source database does not exist at '${this.sourcePath}'.`;
  }
}

export class MigrateDevDbSourceIsDestinationError extends Schema.TaggedError<MigrateDevDbSourceIsDestinationError>()(
  "MigrateDevDbSourceIsDestinationError",
  {
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Source database '${this.sourcePath}' resolves to a path this command rewrites. Pick a different --source or --base-dir.`;
  }
}

export class MigrateDevDbLegacySourceError extends Schema.TaggedError<MigrateDevDbLegacySourceError>()(
  "MigrateDevDbLegacySourceError",
  {
    sourcePath: Schema.String,
    legacyThreads: Schema.Number,
  },
) {
  override get message(): string {
    return `Source database '${this.sourcePath}' holds ${this.legacyThreads} legacy threads the server has not imported into V2 yet, which this command cannot carry over. Start a server once on a T3 home holding a copy of it so it imports them, then pass the userdata/statev2.sqlite that server leaves behind as --source.`;
  }
}

export class MigrateDevDbServerRunningError extends Schema.TaggedError<MigrateDevDbServerRunningError>()(
  "MigrateDevDbServerRunningError",
  {
    databasePath: Schema.String,
    pid: Schema.Number,
  },
) {
  override get message(): string {
    return `Dev database at '${this.databasePath}' is open by a running server (pid ${this.pid} per server-runtime.json). Stop that server first; if that pid is not actually a T3 server (stale descriptor, reused pid), delete the server-runtime.json next to the database and retry.`;
  }
}

export class MigrateDevDbDestinationBusyError extends Schema.TaggedError<MigrateDevDbDestinationBusyError>()(
  "MigrateDevDbDestinationBusyError",
  {
    databasePath: Schema.String,
    reason: Schema.Literals(["write-locked", "wal-held"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const detail =
      this.reason === "write-locked"
        ? "the database is write-locked"
        : "another connection is holding its WAL";
    return `Dev database at '${this.databasePath}' looks in use (${detail}). Stop the dev server first; if none is running, delete the -wal/-shm files next to it.`;
  }
}

export class MigrateDevDbPhaseError extends Schema.TaggedError<MigrateDevDbPhaseError>()(
  "MigrateDevDbPhaseError",
  {
    phase: Schema.Literals(["snapshot", "prune", "compact", "migrate", "clone"]),
    databasePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `migrate-dev-db failed during ${this.phase} on '${this.databasePath}'.`;
  }
}

export interface RunMigrateDevDbInput {
  readonly baseDir?: string | undefined;
  readonly source?: string | undefined;
  readonly projects: number;
  readonly threadsPerProject: number;
  /** Rebuild the cached seed even when a fresh one exists. */
  readonly fresh?: boolean | undefined;
}

export interface RunMigrateDevDbOptions {
  /** Test override for the directory writes must never target. */
  readonly sharedHome?: string | undefined;
}

interface KeptProject {
  readonly title: string;
  readonly threads: number;
}

const removeDatabaseFiles = Effect.fn("removeDatabaseFiles")(function* (databasePath: string) {
  const fs = yield* FileSystem.FileSystem;
  for (const suffix of ["", "-wal", "-shm"]) {
    yield* fs.remove(`${databasePath}${suffix}`).pipe(Effect.orElseSucceed(() => undefined));
  }
});

const ServerRuntimeState = Schema.fromJsonString(Schema.Struct({ pid: Schema.Number }));
const decodeServerRuntimeState = Schema.decodeEffect(ServerRuntimeState);

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

// The runtime PID catches idle servers; leftover -shm files can come from read-only connections.
const ensureNotInUse = Effect.fn("ensureDevDbNotInUse")(function* (databasePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const runtimeStatePath = path.join(path.dirname(databasePath), "server-runtime.json");
  const runtimeState = yield* fs
    .readFileString(runtimeStatePath)
    .pipe(Effect.flatMap(decodeServerRuntimeState), Effect.option);
  if (Option.isSome(runtimeState) && isProcessAlive(runtimeState.value.pid)) {
    return yield* new MigrateDevDbServerRunningError({
      databasePath,
      pid: runtimeState.value.pid,
    });
  }

  if (!(yield* fs.exists(databasePath))) {
    return;
  }
  const checkpoint = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA busy_timeout = 0").unprepared;
    yield* sql.unsafe("BEGIN IMMEDIATE").unprepared;
    yield* sql.unsafe("ROLLBACK").unprepared;
    return yield* sql.unsafe<{ busy: number }>("PRAGMA wal_checkpoint(TRUNCATE)").unprepared;
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: databasePath })),
    Effect.mapError(
      (cause) =>
        new MigrateDevDbDestinationBusyError({
          databasePath,
          reason: "write-locked",
          cause,
        }),
    ),
  );
  if (checkpoint[0] !== undefined && Number(checkpoint[0].busy) !== 0) {
    return yield* new MigrateDevDbDestinationBusyError({
      databasePath,
      reason: "wal-held",
    });
  }
});

const RECOVERY_KINDS: ReadonlyArray<ProjectionStore.ProjectionRecoveryKind> = [
  "queued-runs",
  "runtime",
  "subagent-results",
  "delegated-completions",
];

const CLEARED_TABLES: ReadonlyArray<string> = [
  "scheduled_tasks",
  "orchestration_v2_effect_outbox",
  "orchestration_v2_thread_launch_workflows",
  "orchestration_command_receipts",
  "provider_session_runtime",
  "auth_sessions",
  "auth_pairing_links",
  "peer_environment_links",
];

const PROVIDER_SESSIONS_TABLE = "orchestration_v2_projection_provider_sessions";
const FTS5_SHADOW_SUFFIXES = ["_data", "_idx", "_content", "_docsize", "_config"];

// Settled threads stay: they are most of real history, and the UI shows them.
const rootIsVisible = (sql: SqlClient.SqlClient) => sql`
  root.deleted_at IS NULL
  AND json_extract(root.payload_json, '$.deletedAt') IS NULL
  AND json_extract(root.payload_json, '$.archivedAt') IS NULL`;

// Rowids per copy statement. Each statement is its own short read of the
// source: a read transaction held for the whole copy keeps the live server's
// WAL from checkpointing for as long as the copy runs.
const COPY_CHUNK_ROWIDS = 1000;

/**
 * Rows written mid-copy belong to running threads, which the prune drops. The copy keeps only
 * threads with V2 rows, so the legacy guard refuses sources whose unimported V1 threads would
 * vanish (see LegacyV1ThreadImporter.pendingThreadCount).
 */
const copySourceSlice = Effect.fn("copyDevDbSourceSlice")(function* (
  sourcePath: string,
  kept: Option.Option<KeptRows>,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ATTACH DATABASE ${`${NodeURL.pathToFileURL(sourcePath).href}?mode=ro`} AS src`;
  const schema = yield* sql<{ type: string; name: string; sql: string }>`
    SELECT type, name, sql FROM src.sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`;
  const threadColumns = yield* sql<{ name: string; notnull: number }>`
    SELECT m.name, c."notnull" FROM src.sqlite_master m, pragma_table_info(m.name, 'src') c
    WHERE m.type = 'table' AND c.name = 'thread_id'`;
  const threadIdNullable = new Map(threadColumns.map((row) => [row.name, row.notnull === 0]));
  // FTS5 makes its own shadow tables and contentless rows cannot be copied:
  // create the virtual table, skip its shadow tables and rows, and rebuild the
  // index once the messages and triggers are in.
  const virtualTables = schema
    .filter((entry) => entry.type === "table" && /^CREATE VIRTUAL TABLE/i.test(entry.sql))
    .map((entry) => entry.name);
  const isShadowTable = (name: string) =>
    virtualTables.some((virtual) =>
      FTS5_SHADOW_SUFFIXES.some((suffix) => name === `${virtual}${suffix}`),
    );
  const tables = schema.filter((entry) => entry.type === "table" && !isShadowTable(entry.name));
  const filtered = tables.some((table) => table.name === "orchestration_v2_projection_threads");
  // A row that points into a cleared table cannot be copied, so whatever references one is
  // cleared with it, however far down the chain a newer migration added it.
  const references = yield* sql<{ name: string; parent: string }>`
    SELECT m.name, f."table" AS parent FROM src.sqlite_master m, pragma_foreign_key_list(m.name, 'src') f
    WHERE m.type = 'table'`;
  const cleared = new Set(CLEARED_TABLES);
  for (let grew = true; grew;) {
    grew = false;
    for (const { name, parent } of references) {
      if (cleared.has(parent) && !cleared.has(name)) {
        cleared.add(name);
        grew = true;
      }
    }
  }

  if (tables.some((table) => table.name === "projection_threads")) {
    // The V2 tables, application_event_version, and the partial index arrive in
    // the same migration. Without the hint SQLite scans each thread's stream.
    const [pending] = filtered
      ? yield* sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM src.projection_threads AS thread
          WHERE NOT EXISTS (
            SELECT 1
            FROM src.orchestration_events AS event INDEXED BY orchestration_events_v2_created_threads_idx
            WHERE event.application_event_version = 2
              AND event.aggregate_kind = 'thread'
              AND event.stream_id = thread.thread_id
              AND event.event_type = 'thread.created'
          )`
      : yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM src.projection_threads`;
    const legacyThreads = Number(pending?.count ?? 0);
    if (legacyThreads > 0) {
      return yield* new MigrateDevDbLegacySourceError({ sourcePath, legacyThreads });
    }
  }

  const withoutRowid = new Set(
    (yield* sql<{
      name: string;
    }>`SELECT name FROM pragma_table_list WHERE schema = 'src' AND wr = 1`).map((row) => row.name),
  );

  for (const table of tables) yield* sql.unsafe(table.sql).unprepared;
  if (filtered) {
    yield* sql`CREATE TEMP TABLE copied_threads (thread_id TEXT PRIMARY KEY)`;
    if (Option.isSome(kept)) {
      for (const threadId of kept.value.threadIds) {
        yield* sql`INSERT OR IGNORE INTO copied_threads VALUES (${threadId})`;
      }
    } else {
      yield* sql`INSERT OR IGNORE INTO copied_threads
          SELECT family.thread_id FROM src.orchestration_v2_projection_threads family
          JOIN src.orchestration_v2_projection_threads root ON root.thread_id =
            COALESCE(json_extract(family.payload_json, '$.lineage.rootThreadId'), family.thread_id)
          WHERE ${rootIsVisible(sql)}`;
    }
  }
  const keptProjects = filtered ? Option.map(kept, (rows) => rows.projectIds) : Option.none();
  if (Option.isSome(keptProjects)) {
    yield* sql`CREATE TEMP TABLE copied_projects (project_id TEXT PRIMARY KEY)`;
    for (const projectId of keptProjects.value) {
      yield* sql`INSERT OR IGNORE INTO copied_projects VALUES (${projectId})`;
    }
  }
  for (const { name } of tables) {
    if (cleared.has(name) || virtualTables.includes(name)) continue;
    const nullable = threadIdNullable.get(name);
    const projectEvents = Option.isSome(keptProjects)
      ? `(aggregate_kind = 'project' AND stream_id IN (SELECT project_id FROM copied_projects))`
      : `aggregate_kind = 'project'`;
    const filter = !filtered
      ? "1"
      : name === "orchestration_events"
        ? `(aggregate_kind = 'thread' AND stream_id IN (SELECT thread_id FROM copied_threads))
                OR ${projectEvents} OR aggregate_kind NOT IN ('thread', 'project')`
        : name === "projection_projects" && Option.isSome(keptProjects)
          ? "project_id IN (SELECT project_id FROM copied_projects)"
          : nullable === undefined || name === PROVIDER_SESSIONS_TABLE
            ? "1"
            : `thread_id IN (SELECT thread_id FROM copied_threads)${nullable ? " OR thread_id IS NULL" : ""}`;
    const copy = `INSERT INTO main."${name}" SELECT * FROM src."${name}" WHERE (${filter})`;
    // Without a rowid there is nothing to range over; these tables are small.
    if (withoutRowid.has(name)) {
      yield* sql.unsafe(copy).unprepared;
      continue;
    }
    const [range] = yield* sql.unsafe<{ low: number | null; high: number | null }>(
      `SELECT min(rowid) AS low, max(rowid) AS high FROM src."${name}"`,
    ).unprepared;
    if (range?.low == null || range.high == null) continue;
    for (let start = range.low; start <= range.high; start += COPY_CHUNK_ROWIDS) {
      yield* sql.unsafe(`${copy} AND rowid >= ? AND rowid < ?`, [start, start + COPY_CHUNK_ROWIDS]);
    }
  }
  yield* sql`DELETE FROM main.sqlite_sequence`;
  yield* sql`INSERT INTO main.sqlite_sequence SELECT name, seq FROM src.sqlite_sequence`;
  for (const entry of schema) {
    if (entry.type !== "table") yield* sql.unsafe(entry.sql).unprepared;
  }
  yield* sql`DETACH DATABASE src`;
});

const selectKeptRows = Effect.fn("selectDevDbKeptRows")(function* (input: RunMigrateDevDbInput) {
  const sql = yield* SqlClient.SqlClient;

  // Usage-limit recovery also depends on settings; exclude latest-run failures and recovery choices.
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const recoveryThreadIds = yield* Effect.forEach(RECOVERY_KINDS, (kind) =>
    projections.getRecoveryThreadIds(kind),
  );
  yield* sql`CREATE TEMP TABLE live_threads (thread_id TEXT PRIMARY KEY)`;
  for (const threadId of new Set(recoveryThreadIds.flat())) {
    yield* sql`INSERT INTO live_threads (thread_id) VALUES (${threadId})`;
  }
  yield* sql`INSERT OR IGNORE INTO live_threads (thread_id)
    SELECT r.thread_id FROM orchestration_v2_projection_runs r
    WHERE r.status = 'failed' AND r.ordinal = (
      SELECT MAX(latest.ordinal) FROM orchestration_v2_projection_runs latest
      WHERE latest.thread_id = r.thread_id)
    UNION
    SELECT thread_id FROM orchestration_v2_projection_threads
    WHERE json_extract(payload_json, '$.limitRecovery') IS NOT NULL`;

  // Clone or drop whole thread families to preserve fork and subagent lineage reads.
  yield* sql`CREATE TEMP TABLE thread_families AS
    SELECT thread_id, updated_at,
      COALESCE(json_extract(payload_json, '$.lineage.rootThreadId'), thread_id) AS root_id
    FROM orchestration_v2_projection_threads`;

  yield* sql`CREATE TEMP TABLE stopped_families AS
    SELECT f.root_id, root.project_id, MAX(f.updated_at) AS updated_at, COUNT(*) AS size
    FROM thread_families f
    JOIN orchestration_v2_projection_threads root ON root.thread_id = f.root_id
    WHERE ${rootIsVisible(sql)}
    GROUP BY f.root_id, root.project_id
    HAVING SUM(f.thread_id IN (SELECT thread_id FROM live_threads)) = 0`;

  yield* sql`CREATE TEMP TABLE kept_projects AS
    SELECT p.project_id
    FROM projection_projects p
    LEFT JOIN (
      SELECT project_id, MAX(updated_at) AS last_stopped_at
      FROM stopped_families
      GROUP BY project_id
    ) q ON q.project_id = p.project_id
    WHERE p.deleted_at IS NULL
    ORDER BY (q.last_stopped_at IS NULL) ASC,
      COALESCE(q.last_stopped_at, p.updated_at) DESC
    LIMIT ${input.projects}`;

  yield* sql`CREATE TEMP TABLE kept_threads AS
    SELECT f.thread_id FROM thread_families f
    WHERE f.root_id IN (
      SELECT root_id FROM (
        SELECT
          sf.root_id,
          ROW_NUMBER() OVER (
            PARTITION BY sf.project_id
            ORDER BY sf.updated_at DESC
          ) AS recency_rank
        FROM stopped_families sf
        JOIN kept_projects kp ON kp.project_id = sf.project_id
        -- One orchestrator family can hold hundreds of subagents and most of
        -- the database, so a family larger than the limit is skipped.
        WHERE sf.size <= ${input.threadsPerProject}
      )
      WHERE recency_rank <= ${input.threadsPerProject}
    )`;
});

interface KeptRows {
  readonly threadIds: ReadonlyArray<string>;
  readonly projectIds: ReadonlyArray<string>;
}

/**
 * Runs the prune's selection on a read-only connection to the source, so the copy writes only
 * what the prune keeps. None when the source is behind this checkout's schema.
 */
const selectFromSource = Effect.fn("selectDevDbRowsFromSource")(
  function* (_sourcePath: string, input: RunMigrateDevDbInput) {
    const sql = yield* SqlClient.SqlClient;
    if (yield* hasPendingMigrations()) return yield* Effect.fail("behind");
    yield* selectKeptRows(input);
    const threads = yield* sql<{ thread_id: string }>`SELECT thread_id FROM kept_threads`;
    const projects = yield* sql<{ project_id: string }>`SELECT project_id FROM kept_projects`;
    return {
      threadIds: threads.map((row) => row.thread_id),
      projectIds: projects.map((row) => row.project_id),
    } satisfies KeptRows;
  },
  (effect, sourcePath) =>
    effect.pipe(
      Effect.provide(
        ProjectionStore.layer.pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: sourcePath, readonly: true })),
        ),
      ),
      Effect.option,
    ),
);

const pruneSnapshot = Effect.fn("pruneDevDbSnapshot")(function* (input: RunMigrateDevDbInput) {
  const sql = yield* SqlClient.SqlClient;
  yield* selectKeptRows(input);

  const threadTables = yield* sql<{ name: string }>`
    SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) c
    WHERE m.type = 'table' AND c.name = 'thread_id'
      AND m.name <> ${PROVIDER_SESSIONS_TABLE}`;

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DELETE FROM projection_projects
        WHERE project_id NOT IN (SELECT project_id FROM kept_projects)`;
      yield* sql`DELETE FROM ${sql(PROVIDER_SESSIONS_TABLE)}
        WHERE COALESCE(thread_id, '') NOT IN (SELECT thread_id FROM kept_threads)
          AND provider_session_id NOT IN (
            SELECT provider_session_id FROM orchestration_v2_projection_provider_session_bindings
            WHERE thread_id IN (SELECT thread_id FROM kept_threads)
          )`;
      for (const { name } of threadTables) {
        yield* sql.unsafe(
          `DELETE FROM "${name}" WHERE thread_id NOT IN (SELECT thread_id FROM kept_threads)`,
        ).unprepared;
      }
      yield* sql`DELETE FROM orchestration_v2_projection_context_transfers
        WHERE source_thread_id NOT IN (SELECT thread_id FROM kept_threads)
           OR target_thread_id NOT IN (SELECT thread_id FROM kept_threads)`;
      yield* sql`DELETE FROM orchestration_events
        WHERE (aggregate_kind = 'thread'
            AND stream_id NOT IN (SELECT thread_id FROM kept_threads))
           OR (aggregate_kind = 'project'
            AND stream_id NOT IN (SELECT project_id FROM kept_projects))`;
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.pullRequests', json((
          SELECT json_group_array(json_remove(link.value, '$.watch') ORDER BY link.key)
          FROM json_each(payload_json, '$.pullRequests') AS link)))
        WHERE EXISTS (
          SELECT 1 FROM json_each(payload_json, '$.pullRequests') AS link
          WHERE json_extract(link.value, '$.watch') IS NOT NULL)`;
      // Copied threads keep their real worktree paths, where a settle script would run.
      yield* sql`UPDATE projection_projects
        SET scripts_json = (
          SELECT json_group_array(json_remove(script.value, '$.runOnSettle') ORDER BY script.key)
          FROM json_each(scripts_json) AS script)
        WHERE EXISTS (
          SELECT 1 FROM json_each(scripts_json) AS script
          WHERE json_extract(script.value, '$.runOnSettle') IS NOT NULL)`;
      for (const table of CLEARED_TABLES) {
        yield* sql`DELETE FROM ${sql(table)}`;
      }
    }),
  );

  const keptProjects = yield* sql<{ title: string; threads: number }>`
    SELECT
      p.title,
      (SELECT COUNT(*) FROM orchestration_v2_projection_threads t
        WHERE t.project_id = p.project_id) AS threads
    FROM projection_projects p
    ORDER BY p.updated_at DESC`;
  const [events] = yield* sql<{ count: number }>`
    SELECT COUNT(*) AS count FROM orchestration_events`;
  // Indexing after the prune writes only the kept messages into the index.
  yield* rebuildMessageSearch(sql);

  return {
    projects: keptProjects as ReadonlyArray<KeptProject>,
    eventCount: events?.count ?? 0,
  };
});

// Peer links preview builds recorded 68-70 before main took those slots for other migrations.
// A snapshot with exactly that history drops the preview's schema so main's 68+ can run.
const PEER_LINKS_PREVIEW_HISTORY = [
  "68:PeerLinks",
  "69:PeerLinkFence",
  "70:WaitingLinkRequestIndex",
];

const forgetPeerLinksPreviewHistory = Effect.fn("forgetPeerLinksPreviewHistory")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
  if (tables.length === 0) return;
  const tail = yield* sql<{ migration_id: number; name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 68
    ORDER BY migration_id`;
  const history = tail.map((row) => `${row.migration_id}:${row.name}`);
  if (history.join() !== PEER_LINKS_PREVIEW_HISTORY.join()) return;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_turn_items_waiting_link_idx`;
      yield* sql`DROP TABLE IF EXISTS peer_environment_links`;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 68`;
    }),
  );
});

const SEED_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const SeedCacheMeta = Schema.fromJsonString(
  Schema.Struct({
    builtAt: Schema.Number,
    migrations: Schema.Array(Schema.String),
    projects: Schema.Array(Schema.Struct({ title: Schema.String, threads: Schema.Number })),
    eventCount: Schema.Number,
  }),
);
const decodeSeedCacheMeta = Schema.decodeEffect(SeedCacheMeta);
const encodeSeedCacheMeta = Schema.encodeEffect(SeedCacheMeta);

const checkoutMigrations: ReadonlyArray<string> = [
  ...migrationManifest.map(([id, name]) => `${id}_${name}`),
  ...forkMigrationManifest.map(([id, name]) => `fork:${id}_${name}`),
];

const shortHash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 16);

// This script's own text is in the key, so a changed prune never reuses a seed built by another.
const seedCacheKey = Effect.fn("seedCacheKey")(function* (
  sourcePath: string,
  input: RunMigrateDevDbInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(sourcePath);
  const script = yield* fs.readFileString(import.meta.filename);
  return shortHash(
    [
      sourcePath,
      info.dev,
      Option.getOrUndefined(info.ino),
      Option.getOrUndefined(info.birthtime)?.getTime(),
      input.projects,
      input.threadsPerProject,
      shortHash(script),
    ].join("\0"),
  );
});

const isFresh = (builtAt: number, now: number) => now - builtAt < SEED_CACHE_MAX_AGE_MS;

const readSeedCacheMeta = (file: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(file)),
    Effect.flatMap(decodeSeedCacheMeta),
    Effect.option,
  );

/** A seed migrated by a newer checkout is skipped; one from an older checkout is migrated forward. */
const findCachedSeed = Effect.fn("findCachedDevDbSeed")(function* (
  cacheDir: string,
  key: string,
  now: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs.readDirectory(cacheDir).pipe(Effect.orElseSucceed(() => []));
  let best: { readonly seedPath: string; readonly meta: typeof SeedCacheMeta.Type } | undefined;
  for (const name of names) {
    if (!name.startsWith(`${key}-`) || !name.endsWith(".json")) continue;
    const meta = yield* readSeedCacheMeta(path.join(cacheDir, name));
    const seedPath = path.join(cacheDir, `${name.slice(0, -".json".length)}.sqlite`);
    if (
      Option.isNone(meta) ||
      !isFresh(meta.value.builtAt, now) ||
      !meta.value.migrations.every((migration) => checkoutMigrations.includes(migration)) ||
      !(yield* fs.exists(seedPath))
    ) {
      continue;
    }
    if (best === undefined || meta.value.migrations.length > best.meta.migrations.length) {
      best = { seedPath, meta: meta.value };
    }
  }
  return best;
});

const SCRATCH_FILE = /\.(\d+)\.(?:snapshot|tmp)/;

const pruneSeedCache = Effect.fn("pruneDevDbSeedCache")(function* (cacheDir: string, now: number) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const name of yield* fs.readDirectory(cacheDir).pipe(Effect.orElseSucceed(() => []))) {
    const file = path.join(cacheDir, name);
    const scratch = SCRATCH_FILE.exec(name);
    if (scratch !== null) {
      if (!isProcessAlive(Number(scratch[1]))) {
        yield* fs.remove(file).pipe(Effect.orElseSucceed(() => undefined));
      }
      continue;
    }
    if (!name.endsWith(".json")) continue;
    const meta = yield* readSeedCacheMeta(file);
    if (Option.isSome(meta) && isFresh(meta.value.builtAt, now)) continue;
    yield* removeDatabaseFiles(`${file.slice(0, -".json".length)}.sqlite`);
    yield* fs.remove(file).pipe(Effect.orElseSucceed(() => undefined));
  }
});

// The snapshot is scratch, deleted on any failure, so it needs neither a journal nor fsync.
const scratchDatabase = (filename: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("PRAGMA journal_mode = OFF").unprepared;
      yield* sql.unsafe("PRAGMA synchronous = OFF").unprepared;
    }),
  ).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename })));

const wrapPhase =
  (phase: MigrateDevDbPhaseError["phase"], databasePath: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) => new MigrateDevDbPhaseError({ phase, databasePath, cause })),
    );

const migrateDatabase = Effect.fn("migrateDevDb")(
  function* (_databasePath: string, _layer: ReturnType<typeof NodeSqliteClient.layer>) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA foreign_keys = ON").unprepared;
    yield* forgetPeerLinksPreviewHistory();
    return yield* runMigrations();
  },
  (effect, databasePath, layer) =>
    effect.pipe(Effect.provide(layer), wrapPhase("migrate", databasePath)),
);

const buildSeed = Effect.fn("buildDevDbSeed")(function* (
  sourcePath: string,
  input: RunMigrateDevDbInput,
  entryPath: string,
  now: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const snapshotPath = `${entryPath}.${process.pid}.snapshot`;
  const compactPath = `${entryPath}.${process.pid}.tmp`;
  const seedPath = `${entryPath}.sqlite`;

  return yield* Effect.gen(function* () {
    yield* Console.log(`Selecting threads to keep from ${sourcePath} (read-only)...`);
    const kept = yield* selectFromSource(sourcePath, input);
    yield* Console.log(
      Option.isSome(kept)
        ? `Copying ${kept.value.threadIds.length} threads from ${sourcePath} (read-only)...`
        : `Copying visible threads from ${sourcePath} (read-only)...`,
    );
    yield* copySourceSlice(sourcePath, kept).pipe(
      Effect.provide(scratchDatabase(snapshotPath)),
      Effect.catchTags({
        SqlError: (cause) =>
          Effect.fail(
            new MigrateDevDbPhaseError({ phase: "snapshot", databasePath: sourcePath, cause }),
          ),
      }),
    );

    // Migrate first so prune queries can use columns missing from older sources.
    yield* Console.log("Running migrations on the snapshot...");
    const executed = yield* migrateDatabase(snapshotPath, scratchDatabase(snapshotPath));

    yield* Console.log(
      `Pruning to ${input.projects} projects, ${input.threadsPerProject} stopped threads each...`,
    );
    const pruned = yield* pruneSnapshot(input).pipe(
      Effect.provide(ProjectionStore.layer.pipe(Layer.provideMerge(scratchDatabase(snapshotPath)))),
      wrapPhase("prune", snapshotPath),
    );

    // A copy of only the kept rows is already compact; rewriting it would double the build's writes.
    const sparse = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const [pages] = yield* sql<{ free: number; total: number }>`
        SELECT (SELECT freelist_count FROM pragma_freelist_count) AS free,
          (SELECT page_count FROM pragma_page_count) AS total`;
      return pages !== undefined && pages.free * 4 > pages.total;
    }).pipe(Effect.provide(scratchDatabase(snapshotPath)), wrapPhase("compact", snapshotPath));
    const builtPath = sparse ? compactPath : snapshotPath;
    if (sparse) {
      yield* Console.log(`Compacting into ${seedPath}...`);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`VACUUM INTO ${compactPath}`;
      }).pipe(Effect.provide(scratchDatabase(snapshotPath)), wrapPhase("compact", compactPath));
    }
    // The server boots in WAL mode; set it in the header that every clone copies.
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("PRAGMA journal_mode = WAL").unprepared;
    }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: builtPath })),
      wrapPhase("compact", builtPath),
    );
    // The scratch ran without fsync; flush it before it becomes a seed other worktrees trust.
    yield* Effect.scoped(Effect.flatMap(fs.open(builtPath, { flag: "r+" }), (file) => file.sync));
    yield* fs.chmod(builtPath, 0o600);
    yield* fs.rename(builtPath, seedPath);

    const meta = {
      builtAt: now,
      migrations: checkoutMigrations,
      projects: pruned.projects,
      eventCount: pruned.eventCount,
    };
    const metaPath = `${entryPath}.json`;
    const metaScratch = `${entryPath}.${process.pid}.tmp.json`;
    yield* fs.writeFileString(metaScratch, yield* encodeSeedCacheMeta(meta), { mode: 0o600 });
    yield* fs.rename(metaScratch, metaPath);
    return {
      seedPath,
      meta,
      executedMigrations: executed.map(([id, name]) => `${id}_${name}`),
    };
  }).pipe(
    Effect.ensuring(
      Effect.all([removeDatabaseFiles(snapshotPath), removeDatabaseFiles(compactPath)]),
    ),
  );
});

// macOS clones through clonefile; Linux copyFile clones with FICLONE where the filesystem can.
const cloneSeed = Effect.fn("cloneDevDbSeed")(function* (seedPath: string, databasePath: string) {
  const clonefile = yield* CheckoutCloner.CheckoutCloner;
  const cloned =
    clonefile !== undefined &&
    (yield* clonefile(seedPath, databasePath).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    ));
  if (cloned) return;
  yield* removeDatabaseFiles(databasePath);
  yield* Effect.tryPromise({
    try: () => NodeFS.promises.copyFile(seedPath, databasePath, NodeFS.constants.COPYFILE_FICLONE),
    catch: (cause) => new MigrateDevDbPhaseError({ phase: "clone", databasePath, cause }),
  });
}, Effect.provide(CheckoutCloner.layer));

export const runMigrateDevDb = Effect.fn("runMigrateDevDb")(function* (
  input: RunMigrateDevDbInput,
  options: RunMigrateDevDbOptions = {},
) {
  // Negative SQLite LIMITs mean unlimited; validate direct callers as well as CLI flags.
  if (input.projects < 1 || input.threadsPerProject < 0) {
    return yield* Effect.die("projects must be >= 1 and threadsPerProject >= 0");
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const sharedHome = path.resolve(options.sharedHome ?? path.join(NodeOS.homedir(), ".t3"));
  const sourcePath = path.resolve(
    input.source ?? path.join(sharedHome, "userdata", "statev2.sqlite"),
  );
  const cacheDir = path.join(sharedHome, "dev", "seed-cache");

  const baseDir =
    input.baseDir !== undefined
      ? path.resolve(input.baseDir)
      : yield* resolveWorktreeT3Home(process.cwd());
  if (baseDir === undefined) {
    return yield* new MigrateDevDbNotInWorktreeError();
  }
  const stateDir = path.join(baseDir, "userdata");
  const databasePath = path.join(stateDir, "statev2.sqlite");

  if (!(yield* fs.exists(sourcePath))) {
    return yield* new MigrateDevDbSourceMissingError({ sourcePath });
  }
  const [canonicalBaseDir, canonicalSharedHome] = yield* Effect.all([
    fs.realPath(baseDir).pipe(Effect.orElseSucceed(() => baseDir)),
    fs.realPath(sharedHome).pipe(Effect.orElseSucceed(() => sharedHome)),
  ]);
  if (canonicalBaseDir === canonicalSharedHome) {
    return yield* new MigrateDevDbSharedHomeError();
  }
  const canonicalSourcePath = yield* fs
    .realPath(sourcePath)
    .pipe(Effect.orElseSucceed(() => sourcePath));
  const canonicalDestination = yield* fs
    .realPath(databasePath)
    .pipe(Effect.orElseSucceed(() => databasePath));
  if (canonicalSourcePath === canonicalDestination) {
    return yield* new MigrateDevDbSourceIsDestinationError({ sourcePath });
  }

  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* fs.makeDirectory(cacheDir, { recursive: true, mode: 0o700 });

  const now = yield* Clock.currentTimeMillis;
  const key = yield* seedCacheKey(canonicalSourcePath, input);
  const cached = input.fresh === true ? undefined : yield* findCachedSeed(cacheDir, key, now);
  const seed =
    cached !== undefined
      ? { ...cached, executedMigrations: [] }
      : yield* buildSeed(
          sourcePath,
          input,
          path.join(cacheDir, `${key}-${shortHash(checkoutMigrations.join())}`),
          now,
        );
  if (cached !== undefined) {
    const hours = Math.floor((now - cached.meta.builtAt) / 3_600_000);
    yield* Console.log(
      `Reusing the seed built ${hours}h ago in ${cacheDir}. --fresh rebuilds it from ${sourcePath}.`,
    );
  } else {
    yield* pruneSeedCache(cacheDir, now);
  }

  yield* ensureNotInUse(databasePath);
  yield* removeDatabaseFiles(databasePath);
  yield* cloneSeed(seed.seedPath, databasePath);
  yield* fs.chmod(databasePath, 0o600);
  const executed = yield* migrateDatabase(
    databasePath,
    NodeSqliteClient.layer({ filename: databasePath }),
  );

  const size = (yield* fs.stat(databasePath)).size;
  return {
    databasePath,
    sizeBytes: Number(size),
    projects: seed.meta.projects,
    eventCount: seed.meta.eventCount,
    executedMigrations: [
      ...seed.executedMigrations,
      ...executed.map(([id, name]) => `${id}_${name}`),
    ],
  };
});

const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(0)} KB`;

export const migrateDevDbCommand = Command.make(
  "migrate-dev-db",
  {
    projects: Flag.Int("projects").pipe(
      Flag.withDefault(5),
      Flag.withDescription("How many recently updated projects to keep."),
    ),
    threadsPerProject: Flag.Int("threads-per-project").pipe(
      Flag.withDefault(10),
      Flag.withDescription(
        "How many recent stopped threads, with their forks and subagents, to keep per project. A family with more threads than this is skipped.",
      ),
    ),
    baseDir: Flag.String("base-dir").pipe(
      Flag.optional,
      Flag.withDescription("Isolated .t3 directory. Defaults to the current worktree's .t3."),
    ),
    source: Flag.String("source").pipe(
      Flag.optional,
      Flag.withDescription("Source database. Defaults to ~/.t3/userdata/statev2.sqlite."),
    ),
    fresh: Flag.Boolean("fresh").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Rebuild the shared seed from the source even if one built in the last day exists.",
      ),
    ),
  },
  ({ projects, threadsPerProject, baseDir, source, fresh }) =>
    Effect.gen(function* () {
      const result = yield* runMigrateDevDb({
        projects,
        threadsPerProject,
        baseDir: Option.getOrUndefined(baseDir),
        source: Option.getOrUndefined(source),
        fresh,
      });
      yield* Console.log("");
      yield* Console.log(
        `Dev database ready: ${result.databasePath} (${formatSize(result.sizeBytes)})`,
      );
      for (const project of result.projects) {
        yield* Console.log(`  ${project.title}: ${project.threads} threads`);
      }
      yield* Console.log(`  ${result.eventCount} orchestration events kept`);
      yield* Console.log(
        result.executedMigrations.length === 0
          ? "  Migrations: already current (no new migrations in this checkout)"
          : `  Migrations applied: ${result.executedMigrations.join(", ")}`,
      );
    }),
).pipe(
  Command.withDescription(
    "Rebuild the worktree dev database as a clone of a pruned snapshot of the real ~/.t3 data, built at most daily and shared across worktrees, then run migrations.",
  ),
);

if (import.meta.main) {
  Command.run(migrateDevDbCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
