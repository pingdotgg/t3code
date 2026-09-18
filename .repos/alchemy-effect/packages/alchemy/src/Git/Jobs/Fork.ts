import { LIVE_OBJECTS } from "../Store/ObjectStore.ts";
/**
 * The fork alarm job (DESIGN.md §2.3 Fork).
 *
 * A fork streams a row snapshot from the parent Repo DO over an RPC
 * `Stream` and copies it in batches:
 *
 * - `config` — only the fork-relevant keys (`default_branch`,
 *   `description`); identity keys (repoId/owner/name/created_at/status)
 *   belong to the fork itself.
 * - `refs`, `commits`, `commit_parents` — copied verbatim.
 * - `objects` — `location='row'` rows carry their `zdata` BLOB;
 *   `location='r2'` rows are copied **by reference**: the `r2_key` column
 *   carries the parent's full key, which is immutable and shared
 *   (DESIGN.md §3.2). The parent's R2 prefix is retained while the
 *   Registry reports `fork_count > 0`.
 *
 * Every insert is `INSERT OR IGNORE` keyed on the natural primary key, so
 * the job is idempotent and alarm-re-armable: a crashed run resumes by
 * re-streaming from the start and skipping already-copied rows.
 */
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { StoreError } from "../Protocol/Store.ts";
import type {
  CommitParentRow,
  CommitRow,
  ObjectRow,
  RefRow,
  SqlClient,
} from "../Store/Sql.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot wire shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A snapshotted `objects` row. `zdata` is `null` when `location != 'row'`.
 *
 * NOTE: `zdata` crosses the RPC boundary as **base64**, not raw bytes. The
 * snapshot is a `Stream` of plain objects, which the RPC layer serializes
 * as JSONL — a `Uint8Array` inside one of those objects would arrive as
 * `{"0":31,"1":139,...}` and silently corrupt every forked object.
 */
export interface SnapshotObjectRow {
  readonly oid: string;
  readonly type: number;
  readonly size: number;
  readonly zsize: number;
  readonly location: string;
  /** base64 of `zlib(content)`, or `null` when the bytes live in R2. */
  readonly zdata: string | null;
  /** Full R2 key — may point into the PARENT repo's prefix (shared). */
  readonly r2_key: string | null;
  readonly pack_id: string | null;
  readonly pack_offset: number | null;
}

/**
 * One batch of snapshotted rows from a single table. The union member is
 * discriminated by `table`.
 */
export type SnapshotChunk =
  | {
      readonly table: "config";
      readonly rows: ReadonlyArray<{
        readonly key: string;
        readonly value: string;
      }>;
    }
  | {
      readonly table: "refs";
      readonly rows: ReadonlyArray<{
        readonly name: string;
        readonly oid: string;
      }>;
    }
  | {
      readonly table: "objects";
      readonly rows: ReadonlyArray<SnapshotObjectRow>;
    }
  | {
      readonly table: "commits";
      readonly rows: ReadonlyArray<{
        readonly oid: string;
        readonly tree: string;
        readonly gen: number;
        readonly commit_time: number;
      }>;
    }
  | {
      readonly table: "commit_parents";
      readonly rows: ReadonlyArray<{
        readonly oid: string;
        readonly parent: string;
        readonly ord: number;
      }>;
    };

/** Decodes a snapshot row's base64 `zdata` back into bytes. */
const decodeZData = (
  row: SnapshotObjectRow,
): Effect.Effect<Uint8Array, StoreError> => {
  const decoded = Encoding.decodeBase64(row.zdata ?? "");
  return Result.isSuccess(decoded)
    ? Effect.succeed(decoded.success)
    : Effect.fail(
        new StoreError({ reason: `fork: corrupt zdata for ${row.oid}` }),
      );
};

/** Config keys that transfer from parent to fork. */
const FORKED_CONFIG_KEYS = ["default_branch", "description"] as const;

/** Rows per page for small-row tables. */
const PAGE_SIZE = 400;
/** Rows per page for `objects` (each `zdata` BLOB may be up to 1 MiB). */
const OBJECTS_PAGE_SIZE = 8;

// ─────────────────────────────────────────────────────────────────────────────
// Parent side: produce the snapshot stream
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Streams a point-in-time row snapshot of one repo (the parent side of a
 * fork). Backs the Repo DO's `snapshotRows` RPC method — DO RPC methods may
 * return `Stream`s, and the caller (the fork's alarm job) sees chunks live.
 *
 * Staged (in-flight push) objects are excluded; keyed pagination keeps
 * per-batch memory bounded. The stream is not transactional across pages —
 * a concurrent push may add rows mid-snapshot; forks take whatever refs
 * page they observe, which is the same semantics as `git clone` during a
 * push.
 */
export const snapshotStream = (
  sql: SqlClient,
): Stream.Stream<SnapshotChunk, StoreError> => {
  const config: Stream.Stream<SnapshotChunk, StoreError> = Stream.fromEffect(
    Effect.gen(function* () {
      const rows = yield* sql.all<{ key: string; value: string }>(
        `SELECT key, value FROM config WHERE key IN (${FORKED_CONFIG_KEYS.map(() => "?").join(", ")})`,
        ...FORKED_CONFIG_KEYS,
      );
      return { table: "config", rows } satisfies SnapshotChunk;
    }),
  );

  const refs: Stream.Stream<SnapshotChunk, StoreError> = Stream.paginate(
    "",
    (after: string) =>
      Effect.gen(function* () {
        const rows = yield* sql.all<RefRow>(
          `SELECT name, oid FROM refs WHERE name > ? ORDER BY name LIMIT ?`,
          after,
          PAGE_SIZE,
        );
        const chunk: SnapshotChunk = { table: "refs", rows };
        const next =
          rows.length < PAGE_SIZE
            ? Option.none<string>()
            : Option.some(rows[rows.length - 1]!.name);
        return [rows.length > 0 ? [chunk] : [], next] as const;
      }),
  );

  const objects: Stream.Stream<SnapshotChunk, StoreError> = Stream.paginate(
    "",
    (after: string) =>
      Effect.gen(function* () {
        const rows = yield* sql.all<ObjectRow>(
          `SELECT oid, type, size, zsize, location, zdata, r2_key, pack_id, pack_offset, staged_push
           FROM objects WHERE oid > ? AND ${LIVE_OBJECTS} ORDER BY oid LIMIT ?`,
          after,
          OBJECTS_PAGE_SIZE,
        );
        const chunk: SnapshotChunk = {
          table: "objects",
          rows: rows.map((row): SnapshotObjectRow => ({
            oid: row.oid,
            type: row.type,
            size: row.size,
            zsize: row.zsize,
            location: row.location,
            zdata:
              row.zdata === null
                ? null
                : Encoding.encodeBase64(new Uint8Array(row.zdata)),
            r2_key: row.r2_key,
            pack_id: row.pack_id,
            pack_offset: row.pack_offset,
          })),
        };
        const next =
          rows.length < OBJECTS_PAGE_SIZE
            ? Option.none<string>()
            : Option.some(rows[rows.length - 1]!.oid);
        return [rows.length > 0 ? [chunk] : [], next] as const;
      }),
  );

  const commits: Stream.Stream<SnapshotChunk, StoreError> = Stream.paginate(
    "",
    (after: string) =>
      Effect.gen(function* () {
        const rows = yield* sql.all<CommitRow>(
          `SELECT oid, tree, gen, commit_time FROM commits WHERE oid > ? ORDER BY oid LIMIT ?`,
          after,
          PAGE_SIZE,
        );
        const chunk: SnapshotChunk = { table: "commits", rows };
        const next =
          rows.length < PAGE_SIZE
            ? Option.none<string>()
            : Option.some(rows[rows.length - 1]!.oid);
        return [rows.length > 0 ? [chunk] : [], next] as const;
      }),
  );

  const commitParents: Stream.Stream<SnapshotChunk, StoreError> =
    Stream.paginate(["", ""] as readonly [string, string], (after) =>
      Effect.gen(function* () {
        const rows = yield* sql.all<CommitParentRow>(
          `SELECT oid, parent, ord FROM commit_parents
           WHERE (oid > ? OR (oid = ? AND parent > ?)) ORDER BY oid, parent LIMIT ?`,
          after[0],
          after[0],
          after[1],
          PAGE_SIZE,
        );
        const chunk: SnapshotChunk = { table: "commit_parents", rows };
        const last = rows[rows.length - 1];
        const next =
          rows.length < PAGE_SIZE || last === undefined
            ? Option.none<readonly [string, string]>()
            : Option.some([last.oid, last.parent] as const);
        return [rows.length > 0 ? [chunk] : [], next] as const;
      }),
    );

  // Objects before refs: a partially-copied fork must never advertise a ref
  // whose closure is missing (the job is re-run from scratch anyway, but
  // this ordering makes even a crashed fork's DB internally consistent).
  return config.pipe(
    Stream.concat(objects),
    Stream.concat(commits),
    Stream.concat(commitParents),
    Stream.concat(refs),
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Fork side: apply the snapshot
// ─────────────────────────────────────────────────────────────────────────────

/** Zero-copy-when-possible Uint8Array → ArrayBuffer for BLOB binding. */
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.byteOffset === 0 &&
  bytes.byteLength === bytes.buffer.byteLength &&
  bytes.buffer instanceof ArrayBuffer
    ? bytes.buffer
    : (bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer);

/**
 * Applies one snapshot chunk to the fork's own SQLite. All inserts are
 * `INSERT OR IGNORE` on the natural primary key — re-running the whole
 * snapshot after a crash converges without duplicating rows.
 */
export const applySnapshotChunk = Effect.fn(function* (
  sql: SqlClient,
  chunk: SnapshotChunk,
) {
  switch (chunk.table) {
    case "config": {
      for (const row of chunk.rows) {
        yield* sql.run(
          `INSERT INTO config (key, value) VALUES (?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
          row.key,
          row.value,
        );
      }
      return;
    }
    case "refs": {
      for (const row of chunk.rows) {
        yield* sql.run(
          `INSERT OR IGNORE INTO refs (name, oid) VALUES (?, ?)`,
          row.name,
          row.oid,
        );
      }
      return;
    }
    case "objects": {
      for (const row of chunk.rows) {
        yield* sql.run(
          `INSERT OR IGNORE INTO objects (oid, type, size, zsize, location, zdata, r2_key, pack_id, pack_offset, staged_push)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          row.oid,
          row.type,
          row.size,
          row.zsize,
          row.location,
          row.zdata === null ? null : toArrayBuffer(yield* decodeZData(row)),
          row.r2_key,
          row.pack_id,
          row.pack_offset,
        );
      }
      return;
    }
    case "commits": {
      for (const row of chunk.rows) {
        yield* sql.run(
          `INSERT OR IGNORE INTO commits (oid, tree, gen, commit_time) VALUES (?, ?, ?, ?)`,
          row.oid,
          row.tree,
          row.gen,
          row.commit_time,
        );
      }
      return;
    }
    case "commit_parents": {
      for (const row of chunk.rows) {
        yield* sql.run(
          `INSERT OR IGNORE INTO commit_parents (oid, parent, ord) VALUES (?, ?, ?)`,
          row.oid,
          row.parent,
          row.ord,
        );
      }
      return;
    }
  }
});

/** Dependencies of {@link runForkJob}. */
export interface ForkJobOptions {
  /** The fork's own SQL client. */
  readonly sql: SqlClient;
  /**
   * The parent's snapshot stream — `parentStub.snapshotRows()` from the
   * fork DO's alarm handler. Error type is widened to `unknown` because
   * the stream crosses the RPC boundary.
   */
  readonly snapshot: Stream.Stream<SnapshotChunk, unknown>;
}

/**
 * Drains the parent snapshot into the fork's SQLite. Returns the number of
 * chunks applied. Idempotent; the caller flips `status` to `ready` (and
 * clears the jobs row) on success, or re-arms the alarm on failure.
 */
export const runForkJob = (
  options: ForkJobOptions,
): Effect.Effect<number, StoreError> =>
  options.snapshot.pipe(
    Stream.mapError(
      (error) =>
        new StoreError({
          reason: `fork snapshot stream failed: ${String(error)}`,
        }),
    ),
    Stream.runFoldEffect(
      () => 0,
      (count, chunk) =>
        applySnapshotChunk(options.sql, chunk).pipe(Effect.as(count + 1)),
    ),
  );
