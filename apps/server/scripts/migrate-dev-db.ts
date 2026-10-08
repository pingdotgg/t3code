#!/usr/bin/env node

/**
 * Rebuild an isolated dev database from a pruned snapshot of the real
 * ~/.t3 database, then run this checkout's migrations against it.
 *
 * `vp run migrate-dev-db` from a worktree:
 *   1. Nukes `<worktree>/.t3/userdata/statev2.sqlite`.
 *   2. Copies a slice of the real db (`~/.t3/userdata/statev2.sqlite`,
 *      attached read-only): the schema, and every row except those of
 *      deleted, archived, and settled threads, which are nearly all of a
 *      long-lived database. It then prunes that to the most recently updated
 *      projects and, per project, the most recent threads that have fully
 *      stopped, with
 *      their forks and subagents. Working, settled, and archived threads, and
 *      threads with pending recovery, are skipped, and scheduled tasks and
 *      queued effects are dropped, so the dev server never adopts live work.
 *      Auth sessions, pairing links, command receipts, and provider
 *      runtime rows are dropped — pair a fresh browser against dev.
 *   3. Runs migrations on the result. Because the clone carries the real
 *      `effect_sql_migrations` table, this proves a new migration applies
 *      on top of the real applied set, and the slot check below catches
 *      the silent failure where two branches claim the same
 *      `Migrations/NNN_` id (the second one's CREATE TABLE is skipped).
 *
 * The event log (`orchestration_events`) is pruned per stream while
 * `sqlite_sequence` and the projection cursors carry over untouched, so new events keep appending
 * after the old high-water mark and projection cursors never rewind.
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import { resolveWorktreeT3Home } from "@t3tools/shared/devHome";
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
import { migrationManifest, runMigrations } from "../src/persistence/Migrations.ts";
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

/**
 * Two branches claimed the same Migrations/NNN_ slot: the id was already
 * recorded under a different name, so this checkout's migration was
 * silently skipped and its schema changes never applied.
 */
export class MigrateDevDbSlotCollisionError extends Schema.TaggedError<MigrateDevDbSlotCollisionError>()(
  "MigrateDevDbSlotCollisionError",
  {
    slot: Schema.Number,
    codeName: Schema.String,
    appliedName: Schema.String,
  },
) {
  override get message(): string {
    return `Migration slot collision at ${this.slot}: this checkout registers '${this.codeName}' but the database already applied '${this.appliedName}' in that slot. Renumber the new migration to a free slot.`;
  }
}

export class MigrateDevDbPhaseError extends Schema.TaggedError<MigrateDevDbPhaseError>()(
  "MigrateDevDbPhaseError",
  {
    phase: Schema.Literals(["snapshot", "prune", "compact", "migrate", "verify"]),
    databasePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `migrate-dev-db failed during ${this.phase} on '${this.databasePath}'.`;
  }
}

export interface RunMigrateDevDbInput {
  /** Isolated .t3 directory. Defaults to `<worktree>/.t3` of the cwd. */
  readonly baseDir?: string | undefined;
  /** Source database. Defaults to `~/.t3/userdata/statev2.sqlite`. */
  readonly source?: string | undefined;
  readonly projects: number;
  readonly threadsPerProject: number;
}

export interface RunMigrateDevDbOptions {
  /** Overridable for tests; the directory writes must never target. */
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

/** The slice of server-runtime.json this script cares about. */
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

/** Liveness probe for a running dev server. The server writes its pid to
 * server-runtime.json next to the database, which also catches an idle
 * server holding an open-but-inactive connection. The SQL probes below back
 * that up: BEGIN IMMEDIATE fails while a writer is active, and
 * wal_checkpoint(TRUNCATE) reports busy while another connection holds the
 * WAL. A leftover -shm alone is not a signal — read-only connections cannot
 * clean it up on close. */
const ensureNotInUse = Effect.fn("ensureDevDbNotInUse")(function* (databasePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const runtimeStatePath = path.join(path.dirname(databasePath), "server-runtime.json");
  const runtimeState = yield* fs.readFileString(runtimeStatePath).pipe(
    Effect.flatMap(decodeServerRuntimeState),
    // A missing or malformed descriptor is not a liveness signal.
    Effect.option,
  );
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

/** Tables the prune empties. The copy skips their rows. */
const CLEARED_TABLES: ReadonlyArray<string> = [
  // Pending work the dev server would otherwise pick up and run.
  "scheduled_tasks",
  "orchestration_v2_effect_outbox",
  "orchestration_v2_thread_launch_workflows",
  "orchestration_command_receipts",
  "provider_session_runtime",
  "auth_sessions",
  "auth_pairing_links",
];

/** Shared between threads; the prune keeps the ones a kept thread is bound to. */
const PROVIDER_SESSIONS_TABLE = "orchestration_v2_projection_provider_sessions";

/** Whether the thread aliased `root` is shown: not deleted, archived, or settled. */
const rootIsVisible = (sql: SqlClient.SqlClient) => sql`
  root.deleted_at IS NULL
  AND json_extract(root.payload_json, '$.deletedAt') IS NULL
  AND json_extract(root.payload_json, '$.archivedAt') IS NULL
  AND json_extract(root.payload_json, '$.settledAt') IS NULL
  AND json_extract(root.payload_json, '$.settledOverride') IS NOT 'settled'`;

/**
 * Copies the source into the empty snapshot, without the rows of thread families whose root is
 * hidden. The prune drops those anyway, and they hold nearly all of a long-lived database's
 * events, so copying them is what used to make this take a full-size copy of the real db.
 * A source from before the V2 thread tables has no visibility to filter on, so it is copied
 * whole. One transaction reads the source, so the copy is consistent while the real server writes.
 */
const copySourceSlice = Effect.fn("copyDevDbSourceSlice")(function* (sourcePath: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ATTACH DATABASE ${`${NodeURL.pathToFileURL(sourcePath).href}?mode=ro`} AS src`;
  const schema = yield* sql<{ type: string; name: string; sql: string }>`
    SELECT type, name, sql FROM src.sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`;
  const threadColumns = yield* sql<{ name: string; notnull: number }>`
    SELECT m.name, c."notnull" FROM src.sqlite_master m, pragma_table_info(m.name, 'src') c
    WHERE m.type = 'table' AND c.name = 'thread_id'`;
  const threadIdNullable = new Map(threadColumns.map((row) => [row.name, row.notnull === 0]));
  const tables = schema.filter((entry) => entry.type === "table");
  const filtered = tables.some((table) => table.name === "orchestration_v2_projection_threads");

  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const table of tables) yield* sql.unsafe(table.sql).unprepared;
      if (filtered) {
        yield* sql`CREATE TEMP TABLE copied_threads (thread_id TEXT PRIMARY KEY)`;
        yield* sql`INSERT OR IGNORE INTO copied_threads
          SELECT family.thread_id FROM src.orchestration_v2_projection_threads family
          JOIN src.orchestration_v2_projection_threads root ON root.thread_id =
            COALESCE(json_extract(family.payload_json, '$.lineage.rootThreadId'), family.thread_id)
          WHERE ${rootIsVisible(sql)}`;
      }
      for (const { name } of tables) {
        if (CLEARED_TABLES.includes(name)) continue;
        const nullable = threadIdNullable.get(name);
        const filter = !filtered
          ? ""
          : name === "orchestration_events"
            ? // Two ranges rather than `<>`, so SQLite seeks the (aggregate_kind, stream_id)
              // index instead of scanning every event.
              `WHERE (aggregate_kind = 'thread' AND stream_id IN (SELECT thread_id FROM copied_threads))
                OR aggregate_kind < 'thread' OR aggregate_kind > 'thread'`
            : nullable === undefined || name === PROVIDER_SESSIONS_TABLE
              ? ""
              : `WHERE thread_id IN (SELECT thread_id FROM copied_threads)${nullable ? " OR thread_id IS NULL" : ""}`;
        yield* sql.unsafe(`INSERT INTO main."${name}" SELECT * FROM src."${name}" ${filter}`)
          .unprepared;
      }
      // The source's AUTOINCREMENT high-water marks, so new events append after them.
      yield* sql`DELETE FROM main.sqlite_sequence`;
      yield* sql`INSERT INTO main.sqlite_sequence SELECT name, seq FROM src.sqlite_sequence`;
      for (const entry of schema) {
        if (entry.type !== "table") yield* sql.unsafe(entry.sql).unprepared;
      }
    }),
  );
  yield* sql`DETACH DATABASE src`;
});

const pruneSnapshot = Effect.fn("pruneDevDbSnapshot")(function* (input: RunMigrateDevDbInput) {
  const sql = yield* SqlClient.SqlClient;

  // Threads the server would resume or start work on by itself. Its own
  // recovery queries find most of them; usage-limit recovery also depends on
  // settings, so any thread whose latest run failed or that has a recovery
  // choice counts as live too.
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

  // Forks and subagents read history and results through their lineage, so
  // a thread family is cloned or dropped as a whole. A family is stopped when
  // its root is visible and unsettled and none of its threads is live.
  yield* sql`CREATE TEMP TABLE thread_families AS
    SELECT thread_id, updated_at,
      COALESCE(json_extract(payload_json, '$.lineage.rootThreadId'), thread_id) AS root_id
    FROM orchestration_v2_projection_threads`;

  yield* sql`CREATE TEMP TABLE stopped_families AS
    SELECT f.root_id, root.project_id, MAX(f.updated_at) AS updated_at
    FROM thread_families f
    JOIN orchestration_v2_projection_threads root ON root.thread_id = f.root_id
    WHERE ${rootIsVisible(sql)}
    GROUP BY f.root_id, root.project_id
    HAVING SUM(f.thread_id IN (SELECT thread_id FROM live_threads)) = 0`;

  // Projects with clonable threads outrank empty-but-recent ones: the point
  // of the exercise is thread data, not the project list.
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
      )
      WHERE recency_rank <= ${input.threadsPerProject}
    )`;

  // Every V2 table and every V1 table the lazy importer reads is keyed by
  // thread_id, so one sweep covers both and new tables need no change here.
  // Provider sessions are shared between threads and pruned by binding below.
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

  return {
    projects: keptProjects as ReadonlyArray<KeptProject>,
    eventCount: events?.count ?? 0,
  };
});

/** Compare this checkout's migration registry against what the cloned
 * database recorded: same slot under a different name means the migration
 * was skipped, not applied. */
const verifyMigrationSlots = Effect.fn("verifyMigrationSlots")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const applied = yield* sql<{ migration_id: number; name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations`;
  const appliedById = new Map(applied.map((row) => [Number(row.migration_id), row.name]));
  for (const [slot, codeName] of migrationManifest) {
    const appliedName = appliedById.get(slot);
    if (appliedName !== undefined && appliedName !== codeName) {
      return yield* new MigrateDevDbSlotCollisionError({ slot, codeName, appliedName });
    }
  }
});

export const runMigrateDevDb = Effect.fn("runMigrateDevDb")(function* (
  input: RunMigrateDevDbInput,
  options: RunMigrateDevDbOptions = {},
) {
  // SQLite treats a negative LIMIT as "no limit", which would clone
  // everything. The CLI flags validate this too; this covers direct callers.
  if (input.projects < 1 || input.threadsPerProject < 0) {
    return yield* Effect.die("projects must be >= 1 and threadsPerProject >= 0");
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const sharedHome = path.resolve(options.sharedHome ?? path.join(NodeOS.homedir(), ".t3"));
  const sourcePath = path.resolve(
    input.source ?? path.join(sharedHome, "userdata", "statev2.sqlite"),
  );

  const baseDir =
    input.baseDir !== undefined
      ? path.resolve(input.baseDir)
      : yield* resolveWorktreeT3Home(process.cwd());
  if (baseDir === undefined) {
    return yield* new MigrateDevDbNotInWorktreeError();
  }
  const stateDir = path.join(baseDir, "userdata");
  const databasePath = path.join(stateDir, "statev2.sqlite");
  const snapshotPath = `${databasePath}.migrate-dev-db-tmp`;

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
  // The destination db and snapshot both get deleted below; a --source that
  // resolves to either (e.g. a leftover snapshot file) would be destroyed
  // before it is ever read.
  const canonicalSourcePath = yield* fs
    .realPath(sourcePath)
    .pipe(Effect.orElseSucceed(() => sourcePath));
  for (const destination of [databasePath, snapshotPath]) {
    const canonicalDestination = yield* fs
      .realPath(destination)
      .pipe(Effect.orElseSucceed(() => destination));
    if (canonicalSourcePath === canonicalDestination) {
      return yield* new MigrateDevDbSourceIsDestinationError({ sourcePath });
    }
  }

  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* ensureNotInUse(databasePath);

  const wrapPhase =
    (phase: MigrateDevDbPhaseError["phase"], phaseDatabasePath: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) => new MigrateDevDbPhaseError({ phase, databasePath: phaseDatabasePath, cause }),
        ),
      );

  yield* removeDatabaseFiles(snapshotPath);
  // Make sure the snapshot is removed even when a phase fails partway through.
  const { executedMigrations, pruned } = yield* Effect.gen(function* () {
    yield* Console.log(`Copying visible threads from ${sourcePath} (read-only)...`);
    yield* copySourceSlice(sourcePath).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath })),
      wrapPhase("snapshot", sourcePath),
    );

    // Migrate before pruning: a source older than this checkout would
    // otherwise crash the prune queries on columns that don't exist yet.
    yield* Console.log("Running migrations on the snapshot...");
    const executed = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Mirror server boot (persistence/Sqlite.ts).
      yield* sql.unsafe("PRAGMA foreign_keys = ON").unprepared;
      return yield* runMigrations();
    }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath })),
      wrapPhase("migrate", snapshotPath),
    );

    // Verify while the snapshot is still the only thing touched: a slot
    // collision must abort before the old worktree db gets replaced with a
    // schema whose colliding migration was silently skipped.
    yield* verifyMigrationSlots().pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath })),
      Effect.catchTags({
        SqlError: (cause) =>
          Effect.fail(
            new MigrateDevDbPhaseError({ phase: "verify", databasePath: snapshotPath, cause }),
          ),
      }),
    );

    yield* Console.log(
      `Pruning to ${input.projects} projects, ${input.threadsPerProject} stopped threads each...`,
    );
    const result = yield* pruneSnapshot(input).pipe(
      Effect.provide(
        ProjectionStore.layer.pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: snapshotPath })),
        ),
      ),
      wrapPhase("prune", snapshotPath),
    );

    yield* Console.log(`Compacting into ${databasePath}...`);
    // Re-check right before the swap: a dev server started while the
    // snapshot was migrating and pruning must not lose its database.
    yield* ensureNotInUse(databasePath);
    yield* removeDatabaseFiles(databasePath);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`VACUUM INTO ${databasePath}`;
    }).pipe(
      Effect.provide(NodeSqliteClient.layer({ filename: snapshotPath })),
      wrapPhase("compact", databasePath),
    );
    return { executedMigrations: executed, pruned: result };
  }).pipe(Effect.ensuring(removeDatabaseFiles(snapshotPath)));
  yield* fs.chmod(databasePath, 0o600);

  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // WAL does not survive VACUUM INTO; set it so first `vp run dev` finds
    // the database exactly as server boot would have left it.
    yield* sql.unsafe("PRAGMA journal_mode = WAL").unprepared;
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: databasePath })),
    wrapPhase("compact", databasePath),
  );

  const size = (yield* fs.stat(databasePath)).size;
  return {
    databasePath,
    sizeBytes: Number(size),
    projects: pruned.projects,
    eventCount: pruned.eventCount,
    executedMigrations: executedMigrations.map(([id, name]) => `${id}_${name}`),
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
        "How many recent stopped threads, with their forks and subagents, to keep per project.",
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
  },
  ({ projects, threadsPerProject, baseDir, source }) =>
    Effect.gen(function* () {
      const result = yield* runMigrateDevDb({
        projects,
        threadsPerProject,
        baseDir: Option.getOrUndefined(baseDir),
        source: Option.getOrUndefined(source),
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
    "Rebuild the worktree dev database from a pruned snapshot of the real ~/.t3 data, then run migrations.",
  ),
);

if (import.meta.main) {
  Command.run(migrateDevDbCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
