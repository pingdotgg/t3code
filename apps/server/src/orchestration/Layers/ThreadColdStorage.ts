// @effect-diagnostics nodeBuiltinImport:off
import * as NodeUtil from "node:util";
import * as NodeZlib from "node:zlib";

import { ThreadId } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  parseAttachmentIdFromRelativePath,
  toSafeThreadAttachmentSegment,
} from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ThreadColdStorage, ThreadColdStorageError } from "../Services/ThreadColdStorage.ts";

const gzipAsync = NodeUtil.promisify(NodeZlib.gzip);
const gunzipAsync = NodeUtil.promisify(NodeZlib.gunzip);
const ARCHIVE_SCHEMA = "cold_archive";
const ARCHIVE_VERSION = 1;
const ROW_CHUNK_SIZE = 250;
const RESTORE_CHUNK_PAGE_SIZE = 32;
const BINARY_VALUE_KEY = "__t3_archive_binary_base64";
const encodeUnknownJsonString = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);
const decodeUnknownJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

type SqlRow = Record<string, unknown>;
type ThreadLockEntry = {
  readonly semaphore: Semaphore.Semaphore;
  readonly users: number;
};
type AcquiredThreadLock = {
  readonly rootThreadId: ThreadId;
  readonly semaphore: Semaphore.Semaphore;
};

class ArchiveCodecError extends Data.TaggedError("ArchiveCodecError")<{
  readonly cause: unknown;
}> {}

const THREAD_TABLES = [
  ["orchestration_events", "stream_id"],
  ["orchestration_command_receipts", "aggregate_id"],
  ["checkpoint_diff_blobs", "thread_id"],
  ["provider_session_runtime", "thread_id"],
  ["projection_thread_messages", "thread_id"],
  ["projection_thread_activities", "thread_id"],
  ["projection_thread_sessions", "thread_id"],
  ["projection_turns", "thread_id"],
  ["projection_pending_approvals", "thread_id"],
  ["projection_thread_proposed_plans", "thread_id"],
] as const;

function storageError(operation: string, threadId: string, cause: unknown) {
  return new ThreadColdStorageError({ operation, threadId, cause });
}

function encodeRows(rows: ReadonlyArray<SqlRow>): Effect.Effect<Uint8Array, ArchiveCodecError> {
  return encodeUnknownJsonString(
    rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([column, value]) => [
          column,
          value instanceof Uint8Array
            ? { [BINARY_VALUE_KEY]: Buffer.from(value).toString("base64") }
            : value,
        ]),
      ),
    ),
  ).pipe(
    Effect.map((encoded) => Buffer.from(encoded, "utf8")),
    Effect.mapError((cause) => new ArchiveCodecError({ cause })),
  );
}

function decodeRows(data: Uint8Array): Effect.Effect<ReadonlyArray<SqlRow>, ArchiveCodecError> {
  return decodeUnknownJsonString(Buffer.from(data).toString("utf8")).pipe(
    Effect.flatMap((decoded) =>
      Effect.try({
        try: () => {
          if (!Array.isArray(decoded)) {
            throw new TypeError("Archived table chunk must contain an array of rows");
          }
          return decoded.map((row): SqlRow => {
            if (row === null || typeof row !== "object" || Array.isArray(row)) {
              throw new TypeError("Archived table chunk contains an invalid row");
            }
            return Object.fromEntries(
              Object.entries(row).map(([column, value]) => {
                if (
                  value !== null &&
                  typeof value === "object" &&
                  !Array.isArray(value) &&
                  Object.keys(value).length === 1 &&
                  typeof (value as Record<string, unknown>)[BINARY_VALUE_KEY] === "string"
                ) {
                  return [
                    column,
                    new Uint8Array(
                      Buffer.from(
                        (value as Record<string, string>)[BINARY_VALUE_KEY] as string,
                        "base64",
                      ),
                    ),
                  ];
                }
                return [column, value];
              }),
            );
          });
        },
        catch: (cause) => new ArchiveCodecError({ cause }),
      }),
    ),
    Effect.mapError((cause) =>
      cause instanceof ArchiveCodecError ? cause : new ArchiveCodecError({ cause }),
    ),
  );
}

const THREAD_TABLE_NAMES = new Set<string>(THREAD_TABLES.map(([table]) => table));

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function isSafeAttachmentEntry(entry: string): boolean {
  return (
    entry.length > 0 &&
    entry !== "." &&
    entry !== ".." &&
    !entry.includes("/") &&
    !entry.includes("\\") &&
    !entry.includes("\0")
  );
}

const compress = (data: Uint8Array) =>
  Effect.tryPromise({
    try: () => gzipAsync(data),
    catch: (cause) => new ArchiveCodecError({ cause }),
  }).pipe(Effect.map((value) => new Uint8Array(value)));

const decompress = (data: Uint8Array) =>
  Effect.tryPromise({
    try: () => gunzipAsync(data),
    catch: (cause) => new ArchiveCodecError({ cause }),
  }).pipe(Effect.map((value) => new Uint8Array(value)));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const threadLocksRef = yield* SynchronizedRef.make(new Map<string, ThreadLockEntry>());

  yield* sql.unsafe(`ATTACH DATABASE ? AS ${ARCHIVE_SCHEMA}`, [config.archiveDbPath]);
  yield* sql.unsafe(`PRAGMA ${ARCHIVE_SCHEMA}.auto_vacuum = INCREMENTAL`);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${ARCHIVE_SCHEMA}.archive_threads (
      thread_id TEXT PRIMARY KEY,
      root_thread_id TEXT NOT NULL,
      archive_version INTEGER NOT NULL,
      archived_at TEXT NOT NULL,
      original_bytes INTEGER NOT NULL,
      compressed_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${ARCHIVE_SCHEMA}.archive_thread_chunks (
      thread_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      kind TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (thread_id, chunk_index)
    )
  `);
  yield* sql.unsafe(`
    CREATE INDEX IF NOT EXISTS ${ARCHIVE_SCHEMA}.idx_archive_thread_chunks_thread
    ON archive_thread_chunks(thread_id, chunk_index)
  `);

  const attachmentEntriesForThread = Effect.fn("attachmentEntriesForThread")(function* (
    threadId: string,
  ) {
    const attachmentIds = new Set<string>();
    const attachmentRows = (yield* sql.unsafe(
      `SELECT attachments_json
       FROM projection_thread_messages
       WHERE thread_id = ? AND attachments_json IS NOT NULL`,
      [threadId],
    )) as ReadonlyArray<SqlRow>;
    for (const row of attachmentRows) {
      const attachments = yield* decodeUnknownJsonString(String(row.attachments_json));
      if (!Array.isArray(attachments)) continue;
      for (const attachment of attachments) {
        if (attachment === null || typeof attachment !== "object" || Array.isArray(attachment)) {
          continue;
        }
        const id = (attachment as Record<string, unknown>).id;
        if (typeof id === "string" && id.length > 0) {
          attachmentIds.add(id);
        }
      }
    }

    const archivedEntries = new Set(
      (
        (yield* sql.unsafe(
          `SELECT kind
           FROM ${ARCHIVE_SCHEMA}.archive_thread_chunks
           WHERE thread_id = ? AND kind LIKE 'attachment:%'`,
          [threadId],
        )) as ReadonlyArray<SqlRow>
      ).flatMap((row) => {
        const entry = String(row.kind).slice("attachment:".length);
        return isSafeAttachmentEntry(entry) ? [entry] : [];
      }),
    );
    const entries = yield* fs
      .readDirectory(config.attachmentsDir, { recursive: false })
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "NotFound" ? Effect.succeed([] as string[]) : Effect.fail(error),
        ),
      );
    return entries.filter((entry) => {
      if (archivedEntries.has(entry)) return true;
      const attachmentId = parseAttachmentIdFromRelativePath(entry);
      return attachmentId !== null && attachmentIds.has(attachmentId);
    });
  });

  const removeAttachments = Effect.fn("removeThreadAttachments")(function* (threadId: string) {
    const entries = yield* attachmentEntriesForThread(threadId);
    yield* Effect.forEach(
      entries,
      (entry) => fs.remove(path.join(config.attachmentsDir, entry), { force: true }),
      { concurrency: 4, discard: true },
    );
  });

  const removeProviderLogsImpl = Effect.fn("removeProviderLogs")(function* (threadId: string) {
    const segment = toSafeThreadAttachmentSegment(threadId);
    if (!segment) return;
    const baseName = `${segment}.log`;
    const entries = yield* fs
      .readDirectory(config.providerLogsDir, { recursive: false })
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "NotFound" ? Effect.succeed([] as string[]) : Effect.fail(error),
        ),
      );
    yield* Effect.forEach(
      entries.filter((entry) => {
        if (entry === baseName) return true;
        if (!entry.startsWith(`${baseName}.`)) return false;
        const rotation = entry.slice(baseName.length + 1);
        return (
          rotation.length > 0 &&
          [...rotation].every((character) => character >= "0" && character <= "9")
        );
      }),
      (entry) => fs.remove(path.join(config.providerLogsDir, entry), { force: true }),
      { concurrency: 4, discard: true },
    );
  });

  const reclaimFreePages = Effect.fn("reclaimThreadStorageFreePages")(function* () {
    yield* sql.unsafe("PRAGMA main.incremental_vacuum(2048)");
    yield* sql.unsafe(`PRAGMA ${ARCHIVE_SCHEMA}.incremental_vacuum(2048)`);
  });

  const completeArchiveCleanup = Effect.fn("completeThreadArchiveCleanup")(function* (
    threadId: ThreadId,
  ) {
    yield* removeAttachments(threadId);
    yield* removeProviderLogsImpl(threadId);
    yield* reclaimFreePages();
    yield* sql.unsafe(
      `UPDATE thread_archive_manifests
       SET status = 'cold', updated_at = CURRENT_TIMESTAMP, error = NULL
       WHERE thread_id = ? AND status = 'cleanup_pending'`,
      [threadId],
    );
  });

  const insertChunk = Effect.fn("insertArchiveChunk")(function* (input: {
    readonly threadId: string;
    readonly chunkIndex: number;
    readonly kind: string;
    readonly rowCount: number;
    readonly data: Uint8Array;
  }) {
    yield* sql.unsafe(
      `INSERT INTO ${ARCHIVE_SCHEMA}.archive_thread_chunks
        (thread_id, chunk_index, kind, row_count, data)
       VALUES (?, ?, ?, ?, ?)`,
      [input.threadId, input.chunkIndex, input.kind, input.rowCount, input.data],
    );
  });

  const discardIncompleteArchive = Effect.fn("discardIncompleteThreadArchive")(function* (
    threadId: ThreadId,
  ) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql.unsafe(
          `DELETE FROM ${ARCHIVE_SCHEMA}.archive_thread_chunks WHERE thread_id = ?`,
          [threadId],
        );
        yield* sql.unsafe(`DELETE FROM ${ARCHIVE_SCHEMA}.archive_threads WHERE thread_id = ?`, [
          threadId,
        ]);
        yield* sql.unsafe(
          `DELETE FROM thread_archive_manifests
           WHERE thread_id = ? AND status IN ('pending', 'archiving')`,
          [threadId],
        );
      }),
    );
  });

  const archiveImpl = Effect.fn("archiveThreadImpl")(function* (
    threadId: ThreadId,
    allowRestored: boolean,
  ) {
    const manifestRows = (yield* sql.unsafe(
      `SELECT root_thread_id, archived_at, status
       FROM thread_archive_manifests
       WHERE thread_id = ?`,
      [threadId],
    )) as ReadonlyArray<SqlRow>;
    const threadRows = (yield* sql.unsafe(
      `SELECT thread_id AS root_thread_id, archived_at
       FROM projection_threads
       WHERE thread_id = ? AND deleted_at IS NULL AND archived_at IS NOT NULL`,
      [threadId],
    )) as ReadonlyArray<SqlRow>;
    const manifest = manifestRows[0];
    const source = manifest ?? threadRows[0];
    if (!source) return;
    if (source.status === "cold") return;
    if (source.status === "cleanup_pending") {
      yield* completeArchiveCleanup(threadId);
      return;
    }
    if (threadRows.length === 0) {
      if (source.status === "pending" || source.status === "archiving") {
        yield* discardIncompleteArchive(threadId);
      }
      return;
    }
    if (source.status === "restored" && !allowRestored) return;
    const rootThreadId = String(source.root_thread_id ?? threadId);
    const archivedAt = String(source.archived_at ?? DateTime.formatIso(yield* DateTime.now));

    yield* sql.unsafe(
      `INSERT INTO thread_archive_manifests
        (thread_id, root_thread_id, status, archive_version, archived_at, updated_at, error)
       VALUES (?, ?, 'archiving', ?, ?, CURRENT_TIMESTAMP, NULL)
       ON CONFLICT(thread_id) DO UPDATE SET
         root_thread_id = excluded.root_thread_id,
         status = 'archiving',
         archive_version = excluded.archive_version,
         archived_at = excluded.archived_at,
         updated_at = CURRENT_TIMESTAMP,
         error = NULL`,
      [threadId, rootThreadId, ARCHIVE_VERSION, archivedAt],
    );
    yield* sql.unsafe(`DELETE FROM ${ARCHIVE_SCHEMA}.archive_thread_chunks WHERE thread_id = ?`, [
      threadId,
    ]);
    yield* sql.unsafe(`DELETE FROM ${ARCHIVE_SCHEMA}.archive_threads WHERE thread_id = ?`, [
      threadId,
    ]);

    let chunkIndex = 0;
    let originalBytes = 0;
    let compressedBytes = 0;
    for (const [table, keyColumn] of THREAD_TABLES) {
      let lastRowId = 0;
      while (true) {
        const rows = (yield* sql.unsafe(
          `SELECT rowid AS __archive_rowid, *
           FROM ${table}
           WHERE ${keyColumn} = ? AND rowid > ?
           ORDER BY rowid ASC
           LIMIT ${ROW_CHUNK_SIZE}`,
          [threadId, lastRowId],
        )) as ReadonlyArray<SqlRow>;
        if (rows.length === 0) break;
        const normalizedRows = rows.map((row) => {
          const { __archive_rowid, ...stored } = row;
          lastRowId = Number(__archive_rowid);
          return stored;
        });
        const encoded = yield* encodeRows(normalizedRows);
        const compressed = yield* compress(encoded);
        yield* insertChunk({
          threadId,
          chunkIndex,
          kind: `table:${table}`,
          rowCount: normalizedRows.length,
          data: compressed,
        });
        chunkIndex += 1;
        originalBytes += encoded.byteLength;
        compressedBytes += compressed.byteLength;
      }
    }

    const attachmentEntries = yield* attachmentEntriesForThread(threadId);
    for (const entry of attachmentEntries) {
      const bytes = yield* fs.readFile(path.join(config.attachmentsDir, entry));
      const compressed = yield* compress(bytes);
      yield* insertChunk({
        threadId,
        chunkIndex,
        kind: `attachment:${entry}`,
        rowCount: 1,
        data: compressed,
      });
      chunkIndex += 1;
      originalBytes += bytes.byteLength;
      compressedBytes += compressed.byteLength;
    }

    // Chunk creation stays retryable outside the hot-row deletion transaction.
    // A retry replaces every partial chunk before deleting source data.
    const archivedAtDestructiveBoundary = yield* sql.withTransaction(
      Effect.gen(function* () {
        const archivedShell = (yield* sql.unsafe(
          `SELECT 1 AS present
           FROM projection_threads
           WHERE thread_id = ? AND deleted_at IS NULL AND archived_at IS NOT NULL
           LIMIT 1`,
          [threadId],
        )) as ReadonlyArray<SqlRow>;
        if (archivedShell.length === 0) {
          yield* sql.unsafe(
            `DELETE FROM ${ARCHIVE_SCHEMA}.archive_thread_chunks WHERE thread_id = ?`,
            [threadId],
          );
          yield* sql.unsafe(`DELETE FROM ${ARCHIVE_SCHEMA}.archive_threads WHERE thread_id = ?`, [
            threadId,
          ]);
          yield* sql.unsafe(
            `DELETE FROM thread_archive_manifests
             WHERE thread_id = ? AND status = 'archiving'`,
            [threadId],
          );
          return false;
        }
        yield* sql.unsafe(
          `INSERT INTO ${ARCHIVE_SCHEMA}.archive_threads
            (thread_id, root_thread_id, archive_version, archived_at, original_bytes,
             compressed_bytes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [threadId, rootThreadId, ARCHIVE_VERSION, archivedAt, originalBytes, compressedBytes],
        );
        for (const [table, keyColumn] of [...THREAD_TABLES].toReversed()) {
          yield* sql.unsafe(`DELETE FROM ${table} WHERE ${keyColumn} = ?`, [threadId]);
        }
        yield* sql.unsafe(
          `UPDATE thread_archive_manifests
           SET status = 'cleanup_pending', original_bytes = ?, compressed_bytes = ?,
               updated_at = CURRENT_TIMESTAMP, error = NULL
           WHERE thread_id = ?`,
          [originalBytes, compressedBytes, threadId],
        );
        return true;
      }),
    );

    if (!archivedAtDestructiveBoundary) return;

    yield* completeArchiveCleanup(threadId);
  });

  const insertRows = Effect.fn("restoreArchiveRows")(function* (
    table: string,
    rows: ReadonlyArray<SqlRow>,
  ) {
    if (!THREAD_TABLE_NAMES.has(table)) {
      return yield* new ArchiveCodecError({
        cause: new TypeError(`Archive chunk targets unknown table '${table}'`),
      });
    }
    const tableInfo = (yield* sql.unsafe(
      `PRAGMA main.table_info(${quoteIdentifier(table)})`,
    )) as ReadonlyArray<SqlRow>;
    const currentColumns = new Set(
      tableInfo.flatMap((column) =>
        typeof column.name === "string" && column.name.length > 0 ? [column.name] : [],
      ),
    );
    for (const row of rows) {
      // Archived rows can outlive schema migrations. Ignore columns that no
      // longer exist and let newly-added columns use their database defaults.
      const columns = Object.keys(row).filter((column) => currentColumns.has(column));
      if (columns.length === 0) continue;
      const placeholders = columns.map(() => "?").join(", ");
      yield* sql.unsafe(
        `INSERT OR REPLACE INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${placeholders})`,
        columns.map((column) => row[column]),
      );
    }
  });

  const restoreThread = Effect.fn("restoreArchivedThread")(function* (threadId: ThreadId) {
    const bundleRows = (yield* sql.unsafe(
      `SELECT 1 AS present FROM ${ARCHIVE_SCHEMA}.archive_threads WHERE thread_id = ? LIMIT 1`,
      [threadId],
    )) as ReadonlyArray<SqlRow>;
    if (bundleRows.length === 0) return false;

    const invalidKinds = (yield* sql.unsafe(
      `SELECT kind FROM ${ARCHIVE_SCHEMA}.archive_thread_chunks
       WHERE thread_id = ? AND kind NOT LIKE 'table:%' AND kind NOT LIKE 'attachment:%'
       LIMIT 1`,
      [threadId],
    )) as ReadonlyArray<SqlRow>;
    if (invalidKinds.length > 0) {
      return yield* new ArchiveCodecError({
        cause: new TypeError(
          `Archive contains unknown chunk kind '${String(invalidKinds[0]?.kind)}'`,
        ),
      });
    }

    // Restore files before changing SQL state. A failed or interrupted file
    // write leaves the cold bundle authoritative and can be retried safely.
    let attachmentChunkIndex = -1;
    while (true) {
      const attachmentChunks = (yield* sql.unsafe(
        `SELECT chunk_index, kind, data
         FROM ${ARCHIVE_SCHEMA}.archive_thread_chunks
         WHERE thread_id = ? AND chunk_index > ? AND kind LIKE 'attachment:%'
         ORDER BY chunk_index ASC
         LIMIT ${RESTORE_CHUNK_PAGE_SIZE}`,
        [threadId, attachmentChunkIndex],
      )) as ReadonlyArray<SqlRow>;
      if (attachmentChunks.length === 0) break;
      for (const chunk of attachmentChunks) {
        attachmentChunkIndex = Number(chunk.chunk_index);
        const entry = String(chunk.kind).slice("attachment:".length);
        if (!isSafeAttachmentEntry(entry)) continue;
        const data = yield* decompress(chunk.data as Uint8Array);
        const targetPath = path.join(config.attachmentsDir, entry);
        const temporaryPath = `${targetPath}.t3-restore`;
        yield* fs
          .writeFile(temporaryPath, data)
          .pipe(
            Effect.andThen(fs.remove(targetPath, { force: true })),
            Effect.andThen(fs.rename(temporaryPath, targetPath)),
            Effect.ensuring(fs.remove(temporaryPath, { force: true }).pipe(Effect.ignore)),
          );
      }
    }

    yield* sql.withTransaction(
      Effect.gen(function* () {
        let tableChunkIndex = -1;
        while (true) {
          const tableChunks = (yield* sql.unsafe(
            `SELECT chunk_index, kind, data
             FROM ${ARCHIVE_SCHEMA}.archive_thread_chunks
             WHERE thread_id = ? AND chunk_index > ? AND kind LIKE 'table:%'
             ORDER BY chunk_index ASC
             LIMIT ${RESTORE_CHUNK_PAGE_SIZE}`,
            [threadId, tableChunkIndex],
          )) as ReadonlyArray<SqlRow>;
          if (tableChunks.length === 0) break;
          for (const chunk of tableChunks) {
            tableChunkIndex = Number(chunk.chunk_index);
            const kind = String(chunk.kind);
            const data = yield* decompress(chunk.data as Uint8Array);
            yield* insertRows(kind.slice("table:".length), yield* decodeRows(data));
          }
        }
        yield* sql.unsafe(
          `UPDATE thread_archive_manifests
           SET status = 'restored', updated_at = CURRENT_TIMESTAMP, error = NULL
           WHERE thread_id = ?`,
          [threadId],
        );
      }),
    );

    return true;
  });

  const resolveTreeRoot = Effect.fn("resolveArchiveTreeRoot")(function* (threadId: ThreadId) {
    const rows = (yield* sql.unsafe(
      `SELECT COALESCE(
          (SELECT root_thread_id FROM thread_archive_manifests WHERE thread_id = ?),
          (SELECT thread_id FROM projection_threads WHERE thread_id = ?),
          ?
        ) AS root_thread_id`,
      [threadId, threadId, threadId],
    )) as ReadonlyArray<SqlRow>;
    return ThreadId.make(String(rows[0]?.root_thread_id ?? threadId));
  });

  const restoreTreeImpl = Effect.fn("restoreArchiveTreeImpl")(function* (threadId: ThreadId) {
    const rootThreadId = yield* resolveTreeRoot(threadId);
    const rows = (yield* sql.unsafe(
      `SELECT thread_id, status
       FROM thread_archive_manifests
       WHERE root_thread_id = ? AND status IN ('cleanup_pending', 'cold', 'restored')
       ORDER BY CASE WHEN thread_id = ? THEN 1 ELSE 0 END, thread_id ASC`,
      [rootThreadId, rootThreadId],
    )) as ReadonlyArray<SqlRow>;
    let restored = false;
    for (const row of rows) {
      restored = (yield* restoreThread(ThreadId.make(String(row.thread_id)))) || restored;
    }
    if (restored || rows.some((row) => row.status === "restored")) {
      return true;
    }
    if (rows.length > 0) {
      return false;
    }

    // The lifecycle worker may not have started archiving this shell yet. Mark
    // its still-hot rows as owned by the unarchive command before releasing the
    // tree lock, so a queued archive job cannot delete them before that command
    // commits. A failed command rolls this reservation back through archiveImpl;
    // a successful command removes it through finishRestoreTreeImpl.
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const archivedShell = (yield* sql.unsafe(
          `SELECT archived_at
           FROM projection_threads
           WHERE thread_id = ? AND deleted_at IS NULL AND archived_at IS NOT NULL
           LIMIT 1`,
          [threadId],
        )) as ReadonlyArray<SqlRow>;
        const source = archivedShell[0];
        if (!source) return false;

        yield* sql.unsafe(
          `INSERT INTO thread_archive_manifests
            (thread_id, root_thread_id, status, archive_version, archived_at, updated_at, error)
           VALUES (?, ?, 'restored', ?, ?, CURRENT_TIMESTAMP, NULL)
           ON CONFLICT(thread_id) DO UPDATE SET
             status = 'restored',
             updated_at = CURRENT_TIMESTAMP,
             error = NULL
           WHERE thread_archive_manifests.status IN ('pending', 'archiving')`,
          [threadId, rootThreadId, ARCHIVE_VERSION, String(source.archived_at)],
        );
        return true;
      }),
    );
  });

  const rollbackRestoreTreeImpl = Effect.fn("rollbackRestoreArchiveTreeImpl")(function* (
    threadId: ThreadId,
  ) {
    const rootThreadId = yield* resolveTreeRoot(threadId);
    const rows = (yield* sql.unsafe(
      `SELECT thread_id
       FROM thread_archive_manifests
       WHERE root_thread_id = ? AND status = 'restored'
       ORDER BY CASE WHEN thread_id = ? THEN 1 ELSE 0 END, thread_id ASC`,
      [rootThreadId, rootThreadId],
    )) as ReadonlyArray<SqlRow>;
    for (const row of rows) {
      yield* archiveImpl(ThreadId.make(String(row.thread_id)), true);
    }
  });

  const finishRestoreTreeImpl = Effect.fn("finishRestoreArchiveTreeImpl")(function* (
    threadId: ThreadId,
  ) {
    const rootThreadId = yield* resolveTreeRoot(threadId);
    const rows = (yield* sql.unsafe(
      `SELECT thread_id FROM thread_archive_manifests WHERE root_thread_id = ? AND status = 'restored'`,
      [rootThreadId],
    )) as ReadonlyArray<SqlRow>;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const row of rows) {
          const restoredThreadId = String(row.thread_id);
          yield* sql.unsafe(
            `DELETE FROM ${ARCHIVE_SCHEMA}.archive_thread_chunks WHERE thread_id = ?`,
            [restoredThreadId],
          );
          yield* sql.unsafe(`DELETE FROM ${ARCHIVE_SCHEMA}.archive_threads WHERE thread_id = ?`, [
            restoredThreadId,
          ]);
          yield* sql.unsafe(`DELETE FROM thread_archive_manifests WHERE thread_id = ?`, [
            restoredThreadId,
          ]);
        }
      }),
    );
    yield* sql.unsafe(`PRAGMA ${ARCHIVE_SCHEMA}.incremental_vacuum(2048)`);
  });

  const deleteImpl = Effect.fn("deleteThreadPermanentlyImpl")(function* (threadId: ThreadId) {
    yield* sql.unsafe(
      `INSERT OR IGNORE INTO thread_cleanup_queue (thread_id, reason, created_at)
       VALUES (?, 'deleted', CURRENT_TIMESTAMP)`,
      [threadId],
    );
    // Keep the hot rows or cold chunks available until external cleanup has
    // succeeded so an interrupted delete can recover exact attachment owners.
    yield* removeAttachments(threadId);
    yield* removeProviderLogsImpl(threadId);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql.unsafe(
          `UPDATE projection_thread_proposed_plans
           SET implementation_thread_id = NULL
           WHERE implementation_thread_id = ?`,
          [threadId],
        );
        yield* sql.unsafe(
          `UPDATE projection_turns
           SET source_proposed_plan_thread_id = NULL, source_proposed_plan_id = NULL
           WHERE source_proposed_plan_thread_id = ?`,
          [threadId],
        );
        for (const [table, keyColumn] of [...THREAD_TABLES].toReversed()) {
          yield* sql.unsafe(`DELETE FROM ${table} WHERE ${keyColumn} = ?`, [threadId]);
        }
        yield* sql.unsafe(`DELETE FROM projection_threads WHERE thread_id = ?`, [threadId]);
        yield* sql.unsafe(
          `DELETE FROM ${ARCHIVE_SCHEMA}.archive_thread_chunks WHERE thread_id = ?`,
          [threadId],
        );
        yield* sql.unsafe(`DELETE FROM ${ARCHIVE_SCHEMA}.archive_threads WHERE thread_id = ?`, [
          threadId,
        ]);
        yield* sql.unsafe(`DELETE FROM thread_archive_manifests WHERE thread_id = ?`, [threadId]);
      }),
    );
    yield* reclaimFreePages();
    yield* sql.unsafe(`DELETE FROM thread_cleanup_queue WHERE thread_id = ?`, [threadId]);
  });

  const compactLegacyStorageImpl = Effect.fn("compactLegacyThreadStorage")(function* () {
    const rows = (yield* sql.unsafe(
      `SELECT status FROM thread_storage_maintenance
       WHERE task = 'compact-legacy-thread-storage'`,
    )) as ReadonlyArray<SqlRow>;
    if (rows[0]?.status === "complete") return;

    yield* sql.unsafe(
      `UPDATE thread_storage_maintenance
       SET status = 'running', updated_at = CURRENT_TIMESTAMP, error = NULL
       WHERE task = 'compact-legacy-thread-storage'`,
    );
    yield* sql.unsafe("PRAGMA wal_checkpoint(TRUNCATE)");
    yield* sql.unsafe("PRAGMA main.auto_vacuum = INCREMENTAL");
    yield* sql.unsafe("VACUUM main");
    yield* reclaimFreePages();
    yield* sql.unsafe(
      `UPDATE thread_storage_maintenance
       SET status = 'complete', updated_at = CURRENT_TIMESTAMP, error = NULL
       WHERE task = 'compact-legacy-thread-storage'`,
    );
  });

  const getTreeSemaphore = (threadId: ThreadId) =>
    Effect.flatMap(resolveTreeRoot(threadId), (rootThreadId) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = current.get(rootThreadId);
        if (existing) {
          const next = new Map(current);
          next.set(rootThreadId, { ...existing, users: existing.users + 1 });
          return Effect.succeed([
            { rootThreadId, semaphore: existing.semaphore } satisfies AcquiredThreadLock,
            next,
          ] as const);
        }
        return Semaphore.make(1).pipe(
          Effect.map((semaphore) => {
            const next = new Map(current);
            next.set(rootThreadId, { semaphore, users: 1 });
            return [{ rootThreadId, semaphore } satisfies AcquiredThreadLock, next] as const;
          }),
        );
      }),
    );

  const releaseTreeSemaphore = (acquired: AcquiredThreadLock) =>
    SynchronizedRef.update(threadLocksRef, (current) => {
      const existing = current.get(acquired.rootThreadId);
      if (!existing || existing.semaphore !== acquired.semaphore) return current;
      const next = new Map(current);
      if (existing.users === 1) {
        next.delete(acquired.rootThreadId);
      } else {
        next.set(acquired.rootThreadId, { ...existing, users: existing.users - 1 });
      }
      return next;
    });

  const wrap = <A, E>(operation: string, threadId: ThreadId, effect: Effect.Effect<A, E>) =>
    Effect.acquireUseRelease(
      getTreeSemaphore(threadId),
      ({ semaphore }) => semaphore.withPermit(effect),
      releaseTreeSemaphore,
    ).pipe(Effect.mapError((cause) => storageError(operation, threadId, cause)));

  const listIds = (query: string, operation: string) =>
    sql.unsafe(query).pipe(
      Effect.map((rows) =>
        (rows as ReadonlyArray<SqlRow>).map((row) => ThreadId.make(String(row.thread_id))),
      ),
      Effect.mapError((cause) => storageError(operation, "startup", cause)),
    );

  return {
    archiveThread: (threadId) => wrap("archive", threadId, archiveImpl(threadId, false)),
    restoreTree: (threadId) => wrap("restore", threadId, restoreTreeImpl(threadId)),
    rollbackRestoreTree: (threadId) =>
      wrap("rollback-restore", threadId, rollbackRestoreTreeImpl(threadId)),
    finishRestoreTree: (threadId) =>
      wrap("finish-restore", threadId, finishRestoreTreeImpl(threadId)),
    deleteThread: (threadId) => wrap("delete", threadId, deleteImpl(threadId)),
    removeProviderLogs: (threadId) =>
      wrap("remove-provider-logs", threadId, removeProviderLogsImpl(threadId)),
    compactLegacyStorage: compactLegacyStorageImpl().pipe(
      Effect.mapError((cause) => storageError("compact-legacy-storage", "startup", cause)),
    ),
    listPendingArchiveThreadIds: listIds(
      `SELECT thread_id
       FROM (
         SELECT thread_id, archived_at
         FROM thread_archive_manifests
         WHERE status IN ('pending', 'archiving', 'cleanup_pending')
         UNION ALL
         SELECT projection_threads.thread_id, projection_threads.archived_at
         FROM projection_threads
         WHERE projection_threads.archived_at IS NOT NULL
           AND projection_threads.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM thread_archive_manifests
             WHERE thread_archive_manifests.thread_id = projection_threads.thread_id
           )
       )
       ORDER BY archived_at ASC, thread_id ASC`,
      "list-pending-archives",
    ),
    listPendingDeleteThreadIds: listIds(
      `SELECT thread_id FROM thread_cleanup_queue WHERE reason = 'deleted' ORDER BY created_at ASC, thread_id ASC`,
      "list-pending-deletes",
    ),
  } satisfies ThreadColdStorage["Service"];
});

export const ThreadColdStorageLive = Layer.effect(ThreadColdStorage, make);
