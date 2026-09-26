/**
 * Repo / Registry DO SQLite schema (DESIGN.md §3.1) and typed query helpers.
 *
 * Exposes:
 *
 * - the exact DDL as idempotent init effects ({@link initRepoSchema},
 *   {@link initRegistrySchema}) — run in the DO's outer init under
 *   `blockConcurrencyWhile` semantics,
 * - typed row interfaces mirroring each table,
 * - a small {@link SqlClient} over the raw synchronous `cf.SqlStorage`
 *   surface: `all`/`first`/`run`, the chunked-`IN` helper (≤ 100 bound
 *   params per statement), and the {@link SqlClient.transactionSync}
 *   wrapper every ref mutation goes through (DESIGN.md §3.4).
 *
 * All helpers operate on the raw synchronous SQLite surface (`cursor
 * .toArray()` is synchronous inside a DO) wrapped in `Effect.try`, so SQL
 * failures surface as typed {@link StoreError}s instead of defects.
 */
import type * as cf from "@cloudflare/workers-types";
import type {
  DurableObjectState,
  SqlStorageValue,
} from "../../Cloudflare/Workers/index.ts";
import * as Effect from "effect/Effect";
import { StoreError } from "../Protocol/Store.ts";

// ─────────────────────────────────────────────────────────────────────────────
// DDL (exact, DESIGN.md §3.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Current Repo DO schema version, stored in the `config` table under
 * {@link SCHEMA_VERSION_KEY} for future migrations.
 */
export const SCHEMA_VERSION = 2;

/**
 * The `config` key holding {@link SCHEMA_VERSION}.
 */
export const SCHEMA_VERSION_KEY = "schema_version";

/**
 * The Repo DO DDL, one statement per element, applied in order. Every
 * statement is idempotent (`CREATE TABLE IF NOT EXISTS`), so re-running init
 * after a crash or on every cold start is safe.
 */
export const REPO_DDL: ReadonlyArray<string> = [
  // config: repoId, owner, name, default_branch, description, created_at,
  //         schema_version, status ('ready'|'importing'|'forking'|'deleting'),
  //         read_only ('0'|'1'), fork_of (parent repoId or absent)
  `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // all refs, full names. HEAD is virtual: symref to config.default_branch.
  `CREATE TABLE IF NOT EXISTS refs (
  name TEXT PRIMARY KEY,
  oid  TEXT NOT NULL
) WITHOUT ROWID`,
  // object index + loose bytes. zdata is zlib(content) WITHOUT the loose
  // header, so pack emission is: varint(type,size) + zdata, verbatim.
  `CREATE TABLE IF NOT EXISTS objects (
  oid         TEXT PRIMARY KEY,
  type        INTEGER NOT NULL,
  size        INTEGER NOT NULL,
  zsize       INTEGER NOT NULL,
  location    TEXT NOT NULL DEFAULT 'row',
  zdata       BLOB,
  r2_key      TEXT,
  pack_id     TEXT,
  pack_offset INTEGER,
  staged_push TEXT
) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS idx_objects_staged ON objects(staged_push) WHERE staged_push IS NOT NULL`,
  // commit graph for closure/negotiation walks (populated at ingest)
  `CREATE TABLE IF NOT EXISTS commits (
  oid         TEXT PRIMARY KEY,
  tree        TEXT NOT NULL,
  gen         INTEGER NOT NULL,
  commit_time INTEGER NOT NULL
) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS commit_parents (
  oid    TEXT NOT NULL,
  parent TEXT NOT NULL,
  ord    INTEGER NOT NULL,
  PRIMARY KEY (oid, parent)
) WITHOUT ROWID`,
  // crash-safety bookkeeping for pushes (GC'd by alarm)
  `CREATE TABLE IF NOT EXISTS pushes (
  push_id    TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  state      TEXT NOT NULL
) WITHOUT ROWID`,
  // async job bookkeeping (import/fork/delete-purge progress; one row per kind)
  `CREATE TABLE IF NOT EXISTS jobs (
  kind       TEXT PRIMARY KEY,
  state      TEXT NOT NULL,
  detail     TEXT,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID`,
  // pull requests: base/head are live branch refs — the rows store intent +
  // lifecycle, never a diff snapshot. Rows are never deleted (close, don't
  // delete — numbers stay dense and stable); `merge_commit` is set iff
  // state='merged' (the head tip for a fast-forward, the two-parent merge
  // commit otherwise).
  `CREATE TABLE IF NOT EXISTS pulls (
  number       INTEGER PRIMARY KEY,
  title        TEXT NOT NULL,
  body         TEXT,
  base_ref     TEXT NOT NULL,
  head_ref     TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'open',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  merged_at    INTEGER,
  merge_commit TEXT
) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS idx_pulls_state ON pulls(state, number)`,
];

/**
 * Additive column migrations for Repo tables created by an earlier schema
 * version (mirrors {@link REGISTRY_MIGRATIONS}). `CREATE TABLE IF NOT
 * EXISTS` leaves an existing table untouched, so any future `pulls` (or
 * other) column addition goes here — never into the `CREATE TABLE`.
 * Re-running is safe because "duplicate column name" is swallowed.
 */
export const REPO_MIGRATIONS: ReadonlyArray<string> = [];

/**
 * The Registry DO DDL (DESIGN.md §3.1, bottom): the `owner/name → repoId`
 * authority, listing surface, and fork-lineage ledger.
 */
export const REGISTRY_DDL: ReadonlyArray<string> = [
  `CREATE TABLE IF NOT EXISTS repos (
  owner       TEXT NOT NULL,
  name        TEXT NOT NULL,
  repo_id     TEXT NOT NULL UNIQUE,
  description TEXT,
  fork_of     TEXT,
  fork_count  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  deleted_at  INTEGER,
  -- Denormalised display fields, pushed here by the Repo DO whenever they
  -- change (DESIGN.md section 15, bottleneck 7). The DO remains the source
  -- of truth; these exist so listing repos does not have to wake one
  -- Durable Object per listed row just to render a page.
  default_branch TEXT NOT NULL DEFAULT 'main',
  read_only      INTEGER NOT NULL DEFAULT 0,
  is_public      INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'ready',
  PRIMARY KEY (owner, name)
) WITHOUT ROWID`,
];

// ─────────────────────────────────────────────────────────────────────────────
// Typed row interfaces
// ─────────────────────────────────────────────────────────────────────────────

/** One `config` row. */
export interface ConfigRow extends Record<string, SqlStorageValue> {
  readonly key: string;
  readonly value: string;
}

/** One `refs` row: a full ref name and its 40-hex tip oid. */
export interface RefRow extends Record<string, SqlStorageValue> {
  readonly name: string;
  readonly oid: string;
}

/**
 * One full `objects` row. `zdata` BLOBs come back from workerd SQLite as
 * `ArrayBuffer`s; `location` is `'row' | 'r2' | 'pack'` (pack = v1.1);
 * `staged_push` is `NULL` for live objects, else the staging push id.
 */
export interface ObjectRow extends Record<string, SqlStorageValue> {
  readonly oid: string;
  readonly type: number;
  readonly size: number;
  readonly zsize: number;
  readonly location: string;
  readonly zdata: ArrayBuffer | null;
  readonly r2_key: string | null;
  readonly pack_id: string | null;
  readonly pack_offset: number | null;
  readonly staged_push: string | null;
}

/** The metadata projection of an `objects` row (no byte payload columns). */
export interface ObjectMetaRow extends Record<string, SqlStorageValue> {
  readonly oid: string;
  readonly type: number;
  readonly size: number;
  readonly zsize: number;
  readonly location: string;
}

/** One `commits` row (commit-graph node). */
export interface CommitRow extends Record<string, SqlStorageValue> {
  readonly oid: string;
  readonly tree: string;
  readonly gen: number;
  readonly commit_time: number;
}

/** One `commit_parents` row (commit-graph edge, `ord` = parent position). */
export interface CommitParentRow extends Record<string, SqlStorageValue> {
  readonly oid: string;
  readonly parent: string;
  readonly ord: number;
}

/** One `pushes` row (`state` is `'staging' | 'committed'`). */
export interface PushRow extends Record<string, SqlStorageValue> {
  readonly push_id: string;
  readonly started_at: number;
  readonly state: string;
}

/** One `pulls` row (`state` is `'open' | 'closed' | 'merged'`). */
export interface PullRow extends Record<string, SqlStorageValue> {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly base_ref: string;
  readonly head_ref: string;
  readonly state: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly merged_at: number | null;
  readonly merge_commit: string | null;
}

/** One `jobs` row (`kind` is `'import' | 'fork' | 'purge' | 'gc'`). */
export interface JobRow extends Record<string, SqlStorageValue> {
  readonly kind: string;
  readonly state: string;
  readonly detail: string | null;
  readonly updated_at: number;
}

/** One Registry `repos` row. */
export interface RegistryRepoRow extends Record<string, SqlStorageValue> {
  readonly owner: string;
  readonly name: string;
  readonly repo_id: string;
  readonly description: string | null;
  readonly fork_of: string | null;
  readonly fork_count: number;
  readonly created_at: number;
  readonly deleted_at: number | null;
  /** Denormalised from the Repo DO — see the DDL comment. */
  readonly default_branch: string;
  readonly read_only: number;
  readonly is_public: number;
  readonly status: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunked-IN helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The maximum number of bound parameters per statement (DESIGN.md: chunked
 * `IN` lists ≤ 100 params).
 */
export const MAX_IN_PARAMS = 100;

/**
 * Splits `items` into chunks of at most `size` elements (default
 * {@link MAX_IN_PARAMS}).
 */
export const chunk = <T>(
  items: ReadonlyArray<T>,
  size: number = MAX_IN_PARAMS,
): Array<ReadonlyArray<T>> => {
  const out: Array<ReadonlyArray<T>> = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

/**
 * Builds an `IN`-list placeholder string: `placeholders(3)` → `"?, ?, ?"`.
 */
export const placeholders = (count: number): string =>
  Array.from({ length: count }, () => "?").join(", ");

// ─────────────────────────────────────────────────────────────────────────────
// SqlClient
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Options for {@link SqlClient.inChunks}: fixed bindings placed before /
 * after each chunk's `IN`-list params, and an optional chunk-size override.
 */
export interface InChunksOptions {
  /** Bindings placed before the chunk params in each statement. */
  readonly prefix?: ReadonlyArray<SqlStorageValue> | undefined;
  /** Bindings placed after the chunk params in each statement. */
  readonly suffix?: ReadonlyArray<SqlStorageValue> | undefined;
  /** Max chunk params per statement (capped so total ≤ {@link MAX_IN_PARAMS}). */
  readonly chunkSize?: number | undefined;
}

/**
 * A thin, typed, Effect-wrapped client over a Durable Object's synchronous
 * SQLite surface. Construct with {@link makeSqlClient}. All methods fail with
 * {@link StoreError} on SQL errors (never defects).
 */
export interface SqlClient {
  /** The raw synchronous Cloudflare SQL surface (for advanced callers). */
  readonly raw: cf.SqlStorage;
  /** Runs a query and returns every row. */
  readonly all: <Row extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: Array<SqlStorageValue>
  ) => Effect.Effect<Array<Row>, StoreError>;
  /** Runs a query and returns the first row, or `undefined` when empty. */
  readonly first: <Row extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: Array<SqlStorageValue>
  ) => Effect.Effect<Row | undefined, StoreError>;
  /** Runs a statement for its side effects, consuming any cursor fully. */
  readonly run: (
    query: string,
    ...bindings: Array<SqlStorageValue>
  ) => Effect.Effect<void, StoreError>;
  /**
   * Runs `makeQuery(placeholders)` once per ≤ 100-param chunk of `items` and
   * concatenates the rows. Row order across chunks follows input order of the
   * chunks, but callers must not rely on intra-query ordering.
   */
  readonly inChunks: <Row extends Record<string, SqlStorageValue>>(
    makeQuery: (placeholders: string) => string,
    items: ReadonlyArray<SqlStorageValue>,
    options?: InChunksOptions,
  ) => Effect.Effect<Array<Row>, StoreError>;
  /**
   * Runs `body` inside `DurableObjectStorage.transactionSync` — atomic
   * against mid-event failure, with the DO's input/output gates guaranteeing
   * no interleaving between statements (DESIGN.md §3.4). The body MUST be
   * fully synchronous (no awaits, no Effects).
   *
   * `rollback(error)` aborts the transaction (every statement is rolled
   * back) and surfaces `error` on the typed error channel — this is the CAS
   * abort path for `atomic` pushes. Any other thrown value also rolls back
   * and surfaces as a {@link StoreError}.
   */
  readonly transactionSync: <A, E = never>(
    body: (sql: cf.SqlStorage, rollback: (error: E) => never) => A,
  ) => Effect.Effect<A, StoreError | E>;
}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Internal control-flow signal for {@link SqlClient.transactionSync}. */
class RollbackSignal {
  constructor(readonly error: unknown) {}
}

/**
 * Creates a {@link SqlClient} over a Durable Object's state handle. Plain
 * factory (not a Layer) so `RepoObject.ts` / `RegistryObject.ts` can wire it
 * inside their inner (per-instance) effects.
 */
export const makeSqlClient = (
  state: DurableObjectState["Service"],
): SqlClient => {
  const sql = state.storage.sql.raw;
  const storage = state.raw.storage;

  const allWith = <Row extends Record<string, SqlStorageValue>>(
    query: string,
    bindings: ReadonlyArray<SqlStorageValue>,
  ): Effect.Effect<Array<Row>, StoreError> =>
    Effect.try({
      try: () => sql.exec<Row>(query, ...bindings).toArray(),
      catch: (cause) =>
        new StoreError({
          reason: `sql failed (${query.slice(0, 120)}): ${errorMessage(cause)}`,
        }),
    });

  return {
    raw: sql,
    all: (query, ...bindings) => allWith(query, bindings),
    first: <Row extends Record<string, SqlStorageValue>>(
      query: string,
      ...bindings: Array<SqlStorageValue>
    ) =>
      allWith<Row>(query, bindings).pipe(
        Effect.map((rows) => (rows.length > 0 ? rows[0] : undefined)),
      ),
    run: (query, ...bindings) => allWith(query, bindings).pipe(Effect.asVoid),
    inChunks: <Row extends Record<string, SqlStorageValue>>(
      makeQuery: (ph: string) => string,
      items: ReadonlyArray<SqlStorageValue>,
      options?: InChunksOptions,
    ): Effect.Effect<Array<Row>, StoreError> =>
      Effect.gen(function* () {
        const prefix = options?.prefix ?? [];
        const suffix = options?.suffix ?? [];
        const fixed = prefix.length + suffix.length;
        const size = Math.max(
          1,
          Math.min(options?.chunkSize ?? MAX_IN_PARAMS, MAX_IN_PARAMS - fixed),
        );
        const rows: Array<Row> = [];
        for (const part of chunk(items, size)) {
          const batch = yield* allWith<Row>(
            makeQuery(placeholders(part.length)),
            [...prefix, ...part, ...suffix],
          );
          for (const row of batch) {
            rows.push(row);
          }
        }
        return rows;
      }),
    transactionSync: <A, E = never>(
      body: (sql: cf.SqlStorage, rollback: (error: E) => never) => A,
    ) =>
      Effect.try({
        try: () =>
          storage.transactionSync(() =>
            body(sql, (error: E): never => {
              throw new RollbackSignal(error);
            }),
          ),
        catch: (thrown): StoreError | E =>
          thrown instanceof RollbackSignal
            ? (thrown.error as E)
            : new StoreError({
                reason: `transactionSync failed: ${errorMessage(thrown)}`,
              }),
      }),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Schema init
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Idempotently applies the Repo DO DDL ({@link REPO_DDL}) and seeds the
 * `schema_version` config row. Run in the Repo DO's outer init effect under
 * `blockConcurrencyWhile` semantics.
 */
export const initRepoSchema = Effect.fn(function* (sql: SqlClient) {
  for (const statement of REPO_DDL) {
    yield* sql.run(statement);
  }
  for (const statement of REPO_MIGRATIONS) {
    // Already-applied migrations fail with "duplicate column name" — that
    // is the success case on every run after the first.
    yield* sql.run(statement).pipe(Effect.ignore);
  }
  yield* sql.run(
    `INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING`,
    SCHEMA_VERSION_KEY,
    String(SCHEMA_VERSION),
  );
});

/**
 * Idempotently applies the Registry DO DDL ({@link REGISTRY_DDL}). Run in
 * the Registry DO's outer init effect.
 */
/**
 * Additive column migrations for Registry tables created by an earlier
 * version. `CREATE TABLE IF NOT EXISTS` leaves an existing table untouched,
 * so new columns must be added explicitly; re-running is safe because
 * "duplicate column name" is swallowed.
 */
const REGISTRY_MIGRATIONS: ReadonlyArray<string> = [
  `ALTER TABLE repos ADD COLUMN default_branch TEXT NOT NULL DEFAULT 'main'`,
  `ALTER TABLE repos ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE repos ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE repos ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'`,
];

export const initRegistrySchema = Effect.fn(function* (sql: SqlClient) {
  for (const statement of REGISTRY_DDL) {
    yield* sql.run(statement);
  }
  for (const statement of REGISTRY_MIGRATIONS) {
    // Already-applied migrations fail with "duplicate column name" — that
    // is the success case on every run after the first.
    yield* sql.run(statement).pipe(Effect.ignore);
  }
});
