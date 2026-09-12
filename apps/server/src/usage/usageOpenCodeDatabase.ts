// @effect-diagnostics nodeBuiltinImport:off
/**
 * OpenCode usage source.
 *
 * OpenCode keeps its usage in a SQLite database (`opencode.db` under its XDG
 * data directory) rather than the JSONL transcript directories every other
 * provider scans, so it cannot flow through the byte-offset resume machinery
 * in `usageTranscriptReader` — "resume from an offset" is meaningless for a
 * database. This module is the seam between the two source kinds: a pure
 * row-to-record mapper, and a stateful reader that opens the database
 * read-only and re-reads only what a cursor says it must.
 *
 * Rows in `message` are immutable once written, so a cursor is safe: a row
 * already read can never come back changed. The cursor plus the `(size,
 * mtime)` of the database file *and its `-wal` sidecar* form the cheap
 * "nothing changed" gate that lets a warm scan skip reopening the database.
 *
 * Only the `message` table is ever queried, and only four columns of it.
 * OpenCode's `part` table (tool output) is the bulk of the file by far and
 * never carries usage; touching it would make every scan enormously slow.
 *
 * Both bindings available to the server read SQLite synchronously, so the read
 * is chunked and yields to the event loop between chunks: a cold scan of a
 * large history must not hold the loop for the whole read.
 *
 * @module usageOpenCodeDatabase
 */
import * as NodeFSP from "node:fs/promises";
import type * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { UsageTokenTotals } from "@t3tools/contracts";

import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";
import { expandHomePath } from "../pathExpansion.ts";

/**
 * Longest a read waits out an active writer before degrading.
 *
 * Kept well under a frame budget's worth of user-visible stall: the read runs
 * synchronously on the event loop, so this is dead time for every other
 * request too. A database genuinely held by a writer degrades to a `failed`
 * outcome instead, which the usage screen already reports per source.
 */
const BUSY_TIMEOUT_MS = 200;

/**
 * Rows per synchronous read step.
 *
 * Measured on a synthetic 60,000-row database shaped like OpenCode's: at 500
 * rows a query-plus-parse step costs ~0.7 ms at the real average row width
 * (~425 bytes of `data`) and ~2 ms at a pessimistic 2 KB, against ~93-130 ms
 * for the same scan read in one shot. The 121 yields a cold scan of that size
 * needs cost under 5 ms in total, so chunking is effectively free.
 */
const MESSAGE_CHUNK_ROWS = 500;

/** Suffix of the write-ahead log sidecar OpenCode commits through. */
const WAL_SUFFIX = "-wal";

/**
 * How many times a scan re-reads after finding the file was swapped underneath
 * it. A swap is rare and settles immediately; a path that keeps changing
 * identity degrades rather than spinning.
 */
const MAX_SCAN_ATTEMPTS = 3;

const MESSAGE_CHUNK_SQL =
  "SELECT rowid AS row_id, id, session_id, time_created, data FROM message" +
  " WHERE rowid > ? ORDER BY rowid LIMIT ?";

const MESSAGE_ID_AT_SQL = "SELECT id FROM message WHERE rowid = ?";

/**
 * Raw shape of one `message` row, narrowed to the four columns this source
 * reads. The fields are typed loosely so the mapper can be tested against
 * malformed values the database could never hand back.
 */
export interface OpenCodeMessageRow {
  readonly id: unknown;
  readonly session_id: unknown;
  readonly time_created: unknown;
  readonly data: unknown;
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * Maps one `message` row onto a usage record, or `null` when the row carries
 * no reportable usage.
 *
 * OpenCode reports `output` and `reasoning` as separate, non-overlapping
 * counts — unlike Claude and Codex, whose reasoning is a subset of output —
 * so the two are combined into `outputTokens` here. That preserves the
 * `UsageTokenTotals` invariant that `reasoningTokens` is a subset of
 * `outputTokens`, which `totalTokens` relies on to count each generated
 * token exactly once.
 */
export function parseOpenCodeMessageRow(row: OpenCodeMessageRow): UsageRecord | null {
  // The message id is the record's dedupe key, and the scan keys its cache on
  // it: a row without one must not be emitted at all, or a re-read would
  // double count it.
  if (typeof row.id !== "string" || row.id.length === 0) return null;

  if (typeof row.data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const data = parsed as Record<string, unknown>;

  if (data["role"] !== "assistant") return null;

  // Prefer the high-resolution clock in the payload; the column is the row
  // insert time and the fallback of the two.
  let timestampMs: number | null = null;
  const time = data["time"];
  if (typeof time === "object" && time !== null) {
    const created = (time as Record<string, unknown>)["created"];
    if (typeof created === "number" && Number.isFinite(created) && created > 0) {
      timestampMs = created;
    }
  }
  if (
    timestampMs === null &&
    typeof row.time_created === "number" &&
    Number.isFinite(row.time_created) &&
    row.time_created > 0
  ) {
    timestampMs = row.time_created;
  }
  if (timestampMs === null) return null;

  const model = data["modelID"];
  // Kept raw: the model breakdown and rate lookup key on exactly this string.
  if (typeof model !== "string" || model.length === 0) return null;

  const tokens = data["tokens"];
  const tokensRecord =
    typeof tokens === "object" && tokens !== null ? (tokens as Record<string, unknown>) : {};
  const cache = tokensRecord["cache"];
  const cacheRecord =
    typeof cache === "object" && cache !== null ? (cache as Record<string, unknown>) : {};

  const output = tokenCount(tokensRecord["output"]);
  const reasoning = tokenCount(tokensRecord["reasoning"]);
  // OpenCode's `input` is already non-cached (cache reads/writes sit beside
  // it), so the three input counts are disjoint, matching UsageTokenTotals.
  const totals: UsageTokenTotals = {
    uncachedInputTokens: tokenCount(tokensRecord["input"]),
    cachedInputTokens: tokenCount(cacheRecord["read"]),
    cacheCreationTokens: tokenCount(cacheRecord["write"]),
    outputTokens: output + reasoning,
    reasoningTokens: reasoning,
  };

  const cost = data["cost"];
  const reportedCostUsd = typeof cost === "number" && Number.isFinite(cost) ? cost : null;

  // Rows with neither tokens nor cost are empty or cancelled turns, not usage.
  // A reported zero is no cost for this purpose — OpenCode writes `cost: 0` on
  // turns that produced nothing — but a zero cost on a row that does have
  // tokens is kept as reported rather than repriced from the rate table.
  if (totalTokens(totals) === 0 && (reportedCostUsd === null || reportedCostUsd === 0)) {
    return null;
  }

  return {
    provider: "opencode",
    timestampMs,
    model,
    sessionId: typeof row.session_id === "string" ? row.session_id : "",
    totals,
    reportedCostUsd,
    dedupeKey: row.id,
  };
}

/**
 * Resolves OpenCode's usage database the way OpenCode itself resolves its
 * data directory: `$XDG_DATA_HOME/opencode` when that variable is set, else
 * the platform default `~/.local/share/opencode`. T3 Code's OpenCode settings
 * expose no home override to honour.
 */
export function resolveOpenCodeDatabasePath(input: {
  readonly xdgDataHome: string | undefined;
  readonly homedir: string;
}): string {
  // Whitespace must fall through to the default: coalescing an empty string
  // as a path would resolve against the process cwd.
  const configured = input.xdgDataHome?.trim() ?? "";
  const dataHome =
    configured.length > 0
      ? NodePath.resolve(expandHomePath(configured))
      : NodePath.join(input.homedir, ".local", "share");
  return NodePath.join(dataHome, "opencode", "opencode.db");
}

/**
 * The reader's incremental state, held by the service alongside its file
 * scan cache.
 */
export interface OpenCodeScanState {
  /** Every record read so far, keyed by message id (the dedupe key). */
  readonly records: Map<string, UsageRecord>;
  /**
   * Highest `message` rowid read so far; the next scan reads `rowid >` this.
   *
   * The cursor is the rowid and deliberately NOT `time_created`. Timestamps
   * come from the writer's wall clock across concurrent sessions, so they move
   * backwards relative to insert order — on a real installation ~1% of rows
   * carry a `time_created` lower than the row inserted before them. A
   * timestamp cursor drops every one of those rows permanently. Rowids only
   * ever increase with insert order, so `rowid > cursor` cannot miss a row and
   * needs no overlap window. `time.created` still buckets a record into a day;
   * only the cursor changed.
   */
  highWaterRowId: number;
  /**
   * Message id of the row the cursor sits on, which proves the cursor still
   * means what it meant. SQLite hands a deleted rowid back to the next insert
   * once it was the largest one, so a cursor left alone could point at a
   * different message, or at none, and silently skip everything above it.
   */
  highWaterMessageId: string;
  /** `(size, mtime)` of the database file the records came from. */
  size: number;
  mtimeMs: number;
  /**
   * `(size, mtime)` of the `-wal` sidecar, or `-1` when there is none.
   *
   * OpenCode commits through WAL, so a new message appends to `opencode.db-wal`
   * and can leave `opencode.db` untouched until a checkpoint. Without the
   * sidecar in the gate a warm scan would report stale usage for as long as
   * the checkpoint takes. A database not in WAL mode simply has no sidecar,
   * which is a valid state, not an error.
   */
  walSize: number;
  walMtimeMs: number;
  /** Filesystem identity of the database file, as `device:inode`. */
  volumeId: string;
  /** False until a read succeeds, so the first scan cannot take the fast path. */
  hasRead: boolean;
}

export function createOpenCodeScanState(): OpenCodeScanState {
  return {
    records: new Map(),
    highWaterRowId: 0,
    highWaterMessageId: "",
    size: -1,
    mtimeMs: -1,
    walSize: -1,
    walMtimeMs: -1,
    volumeId: "",
    hasRead: false,
  };
}

/**
 * Drops everything read from a database that is no longer the one at the path.
 * A replacement shares no rowids with what came before, so merging the two
 * would stitch together records from two different databases.
 */
function forgetOpenCodeScanState(state: OpenCodeScanState): void {
  state.records.clear();
  state.highWaterRowId = 0;
  state.highWaterMessageId = "";
  state.size = -1;
  state.mtimeMs = -1;
  state.walSize = -1;
  state.walMtimeMs = -1;
  state.volumeId = "";
  state.hasRead = false;
}

export type OpenCodeScanOutcome =
  | { readonly status: "ok"; readonly volumeId: string; readonly records: readonly UsageRecord[] }
  | { readonly status: "missing"; readonly volumeId: string }
  | { readonly status: "failed"; readonly volumeId: string; readonly detail: string };

export interface OpenCodeScanOptions {
  /**
   * Cached records older than this are dropped, mirroring the file scan
   * cache's retention: they sit behind the cursor and beyond the longest
   * window the UI offers, so they would only cost memory.
   */
  readonly retentionCutoffMs?: number;
}

/** True for the one stat failure that means "there is simply no file here". */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Absent file, or the reason it could not be read.
 *
 * An unreadable database is not the same as an absent one: reporting a
 * permission or I/O failure as "no database" would tell the user nothing is
 * there when in fact their history exists and is unreachable.
 */
async function statOrNull(path: string): Promise<NodeFS.Stats | null> {
  try {
    return await NodeFSP.stat(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Stat that treats every failure as absent, for probes where that is right. */
async function statOrAbsent(path: string): Promise<NodeFS.Stats | null> {
  try {
    return await statOrNull(path);
  } catch {
    return null;
  }
}

async function readVolumeId(path: string): Promise<string> {
  const stats = await statOrAbsent(path);
  return stats === null ? "" : `${stats.dev}:${stats.ino}`;
}

/**
 * Reads OpenCode's database and returns the source's full record set.
 *
 * Incremental by rowid cursor: a warm scan reopens the database only when the
 * `(size, mtime)` of the file or its `-wal` sidecar changed, and then reads
 * only rows above the cursor, merging them into the records already held.
 * This never rejects — a locked, busy, corrupt or missing database degrades to
 * a `missing`/`failed` outcome so the usage read keeps working for every other
 * provider, exactly as a missing transcript directory does.
 */
export async function scanOpenCodeDatabase(
  dbPath: string,
  state: OpenCodeScanState,
  options: OpenCodeScanOptions = {},
): Promise<OpenCodeScanOutcome> {
  let volumeId = "";
  try {
    for (let attempt = 1; ; attempt += 1) {
      const stats = await statOrNull(dbPath);
      if (stats === null) return { status: "missing", volumeId: "" };
      volumeId = `${stats.dev}:${stats.ino}`;
      const wal = await statOrAbsent(`${dbPath}${WAL_SUFFIX}`);
      const walSize = wal === null ? -1 : wal.size;
      const walMtimeMs = wal === null ? -1 : wal.mtimeMs;

      // A replaced database file (a restore, a VACUUM rewrite) shares nothing
      // with the rows already held: forget the cache and the cursor rather
      // than stitching two different databases together.
      if (state.hasRead && state.volumeId !== volumeId) forgetOpenCodeScanState(state);

      // Cheap "nothing changed" gate. Neither file moving means nothing was
      // written to the database at all, so the held records are still
      // complete — the same gate the file pipeline caches parsed files on.
      if (
        state.hasRead &&
        state.size === stats.size &&
        state.mtimeMs === stats.mtimeMs &&
        state.walSize === walSize &&
        state.walMtimeMs === walMtimeMs
      ) {
        pruneOpenCodeRecords(state, options.retentionCutoffMs);
        return { status: "ok", volumeId, records: [...state.records.values()] };
      }

      const read = await readOpenCodeMessageRows(
        dbPath,
        state.highWaterRowId,
        state.highWaterMessageId,
      );

      // The stat above and the open below are not atomic, and the read spans
      // several steps: if the path stopped pointing at the file this scan
      // measured, the rows just read may belong to a different database.
      // Start over against whatever is there now instead of merging.
      if (read.openedVolumeId !== volumeId || read.closingVolumeId !== volumeId) {
        forgetOpenCodeScanState(state);
        if (attempt < MAX_SCAN_ATTEMPTS) continue;
        return {
          status: "failed",
          volumeId,
          detail: "OpenCode database kept being replaced while it was read.",
        };
      }

      // A rewind re-read the whole table, so what it returns is the complete
      // truth. Keeping the old map would preserve rows that have since been
      // deleted, which is what forced the rewind in the first place.
      if (read.resetFromBeginning) state.records.clear();
      for (const record of read.records) {
        // parseOpenCodeMessageRow only emits records that carry the message id
        // as their dedupe key, so this merge is idempotent.
        if (record.dedupeKey !== null) state.records.set(record.dedupeKey, record);
      }
      state.highWaterRowId = read.nextRowId;
      state.highWaterMessageId = read.nextMessageId;
      state.size = stats.size;
      state.mtimeMs = stats.mtimeMs;
      state.walSize = walSize;
      state.walMtimeMs = walMtimeMs;
      state.volumeId = volumeId;
      state.hasRead = true;
      pruneOpenCodeRecords(state, options.retentionCutoffMs);

      return { status: "ok", volumeId, records: [...state.records.values()] };
    }
  } catch (cause) {
    return { status: "failed", volumeId, detail: boundedDetail(cause) };
  }
}

function pruneOpenCodeRecords(state: OpenCodeScanState, retentionCutoffMs: number | undefined) {
  if (retentionCutoffMs === undefined) return;
  for (const [key, record] of state.records) {
    if (record.timestampMs < retentionCutoffMs) state.records.delete(key);
  }
}

function boundedDetail(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : "OpenCode database could not be read.";
}

/**
 * The two SQLite bindings the server supports, behind one read-only face.
 * `persistence/Layers/Sqlite.ts` makes the same runtime split for T3 Code's
 * own database. Every method runs synchronously, which is why the caller
 * reads in chunks.
 */
interface ReadOnlyOpenCodeDatabase {
  setBusyTimeout(ms: number): void;
  /** Message id at a rowid, or `""` when no row holds it any more. */
  messageIdAt(rowId: number): string;
  queryMessageChunk(afterRowId: number, limit: number): readonly unknown[];
  close(): void;
}

function messageIdOf(result: unknown): string {
  const value = (result as Record<string, unknown> | undefined | null)?.["id"];
  return typeof value === "string" ? value : "";
}

/**
 * Opens the database read-only. Read-only matters twice over: OpenCode may be
 * running and writing to this file through WAL while the scan reads it, and a
 * usage scan must never create, migrate or otherwise mutate another process's
 * database. Both bindings refuse to create the file in read-only mode.
 */
async function openOpenCodeDatabase(dbPath: string): Promise<ReadOnlyOpenCodeDatabase> {
  if (process.versions.bun !== undefined) {
    const { Database } = await import("bun:sqlite");
    const db = new Database(dbPath, { readonly: true, create: false });
    const chunk = db.query(MESSAGE_CHUNK_SQL);
    const idAt = db.query(MESSAGE_ID_AT_SQL);
    return {
      setBusyTimeout: (ms) => db.exec(`PRAGMA busy_timeout = ${ms};`),
      messageIdAt: (rowId) => messageIdOf(idAt.get(rowId)),
      queryMessageChunk: (afterRowId, limit) => chunk.all(afterRowId, limit) as readonly unknown[],
      close: () => db.close(),
    };
  }
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const chunk = db.prepare(MESSAGE_CHUNK_SQL);
  const idAt = db.prepare(MESSAGE_ID_AT_SQL);
  return {
    setBusyTimeout: (ms) => db.exec(`PRAGMA busy_timeout = ${ms};`),
    messageIdAt: (rowId) => messageIdOf(idAt.get(rowId)),
    queryMessageChunk: (afterRowId, limit) => chunk.all(afterRowId, limit) as readonly unknown[],
    close: () => db.close(),
  };
}

/** Hands the event loop back so other requests run between read steps. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

interface OpenCodeRead {
  readonly records: readonly UsageRecord[];
  /**
   * True when the cursor was rewound and the whole table was re-read. The
   * caller must drop its cached records first: a rewind happens because rows
   * were deleted, and a merge alone would keep reporting them forever.
   */
  readonly resetFromBeginning: boolean;
  /** Cursor for the next scan: the highest rowid this read reached. */
  readonly nextRowId: number;
  /** Message id sitting at `nextRowId`, so the next scan can trust it. */
  readonly nextMessageId: string;
  /** Identity of the path right after the open, for the caller's swap check. */
  readonly openedVolumeId: string;
  /** Identity of the path once the read finished, still holding the handle. */
  readonly closingVolumeId: string;
}

async function readOpenCodeMessageRows(
  dbPath: string,
  fromRowId: number,
  fromMessageId: string,
): Promise<OpenCodeRead> {
  const db = await openOpenCodeDatabase(dbPath);
  try {
    const openedVolumeId = await readVolumeId(dbPath);
    // Best effort: a busy timeout lets a chunk ride out a brief writer lock
    // instead of degrading the whole scan. The pragma writes nothing.
    try {
      db.setBusyTimeout(BUSY_TIMEOUT_MS);
    } catch {
      // Ignore; the reads below still degrade cleanly on a real lock.
    }

    let cursor = fromRowId;
    let cursorMessageId = fromMessageId;
    // SQLite hands a deleted rowid back to the next insert once it was the
    // largest one, so the cursor can come to rest on a row that is gone or on
    // a different message, with unread rows above it. Reading from scratch
    // after a tail deletion is cheap next to losing those rows.
    let resetFromBeginning = false;
    if (cursor > 0 && cursorMessageId.length > 0 && db.messageIdAt(cursor) !== cursorMessageId) {
      cursor = 0;
      cursorMessageId = "";
      resetFromBeginning = true;
    }

    const records: UsageRecord[] = [];
    for (;;) {
      const rows = db.queryMessageChunk(cursor, MESSAGE_CHUNK_ROWS);
      for (const row of rows) {
        const values = row as Record<string, unknown>;
        const rowId = values["row_id"];
        // The cursor advances from the raw column, not from parsed records:
        // rows skipped as non-usage still prove the scan passed them. Rows
        // committed mid-read land above the cursor and are picked up by a
        // later chunk or the next scan, never missed.
        if (typeof rowId === "number" && Number.isFinite(rowId) && rowId > cursor) {
          cursor = rowId;
          cursorMessageId = typeof values["id"] === "string" ? values["id"] : "";
        }
        const record = parseOpenCodeMessageRow({
          id: values["id"],
          session_id: values["session_id"],
          time_created: values["time_created"],
          data: values["data"],
        });
        if (record !== null) records.push(record);
      }
      if (rows.length < MESSAGE_CHUNK_ROWS) break;
      await yieldToEventLoop();
    }

    return {
      records,
      resetFromBeginning,
      nextRowId: cursor,
      nextMessageId: cursorMessageId,
      openedVolumeId,
      closingVolumeId: await readVolumeId(dbPath),
    };
  } finally {
    try {
      db.close();
    } catch {
      // A failed close must not shadow the read's outcome.
    }
  }
}
