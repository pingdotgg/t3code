// @effect-diagnostics nodeBuiltinImport:off
/**
 * Raw filesystem access for transcript scanning.
 *
 * Isolated here so the rest of the usage code stays on Effect's `FileSystem`.
 * The direct `node:fs` streaming is deliberate: a cold 30-day window is ~1.4 GB
 * across ~1,500 files, and `readline` over a read stream is roughly an order of
 * magnitude cheaper than materialising each file. The equivalent Effect stream
 * pipeline is idiomatic but not fast enough to sit behind a page load.
 *
 * OpenCode moved its transcripts into a SQLite database, so its scan goes
 * through `node:sqlite` instead of the file walk.
 *
 * @module usageTranscriptReader
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeWorkerThreads from "node:worker_threads";

import type { UsageProviderKind } from "@t3tools/contracts";

import {
  initialCodexScanState,
  mightCarryUsage,
  parseClaudeLine,
  parseCodexLine,
  parseGrokLine,
  parseOpenCodeUsageRow,
  type OpenCodeUsageRow,
  type UsageRecord,
} from "./usageTranscripts.ts";

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface TranscriptFileListing {
  readonly files: readonly TranscriptFile[];
  readonly hadReadError: boolean;
}

/**
 * Lists `.jsonl` transcripts under `root` last modified at or after `sinceMs`.
 *
 * Errors on individual entries are swallowed: session files rotate and get
 * removed while the walk is in flight, and a partial listing is far better than
 * failing the page.
 *
 * `fileName` restricts the walk to a single basename (Grok's `updates.jsonl`).
 * Grok sessions also ship multi-megabyte `chat_history` and `events` logs that
 * never carry usage, so the basename filter keeps a cold scan off those files.
 */
export async function listTranscriptFiles(
  root: string,
  sinceMs: number,
  options?: { readonly fileName?: string },
): Promise<TranscriptFileListing> {
  const found: TranscriptFile[] = [];
  let hadReadError = false;
  const fileName = options?.fileName;

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch {
      hadReadError = true;
      return;
    }
    for (const entry of entries) {
      const child = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (fileName !== undefined) {
        if (entry.name !== fileName) continue;
      } else if (!entry.name.endsWith(".jsonl")) {
        continue;
      }
      try {
        const stats = await NodeFSP.stat(child);
        if (stats.mtimeMs >= sinceMs) {
          found.push({ path: child, size: stats.size, mtimeMs: stats.mtimeMs });
        }
      } catch (cause) {
        // Rotating transcripts can vanish between readdir and stat. Other
        // failures mean the listing may have silently omitted usable data.
        if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) {
          hadReadError = true;
        }
      }
    }
  };

  await walk(root);
  return { files: found, hadReadError };
}

/**
 * Filesystem identity of a directory, as `device:inode`.
 *
 * Used to tell "two servers reading the same transcript directory" apart from
 * "two machines whose hostname and home path happen to match". Returns an empty
 * string when the directory cannot be stat'd.
 */
export async function readDirectoryVolumeId(path: string): Promise<string> {
  try {
    const stats = await NodeFSP.stat(path);
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return "";
  }
}

/**
 * Streams one transcript and returns the usage records it contains, or `null`
 * when the file could not be read.
 *
 * The distinction matters to the caller's cache: a genuinely empty transcript
 * is a stable fact worth memoising, while a transient read failure memoised
 * under the same `(size, mtime)` key would silently drop that file's usage
 * until the file next changes.
 *
 * Codex carries the active model on `turn_context` lines that hold no usage of
 * their own, so those still have to pass through the reducer to keep model
 * attribution correct.
 */
export async function readTranscriptRecords(
  filePath: string,
  provider: UsageProviderKind,
): Promise<readonly UsageRecord[] | null> {
  const records: UsageRecord[] = [];
  const codexState = initialCodexScanState();

  try {
    const lines = NodeReadline.createInterface({
      input: NodeFS.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (provider === "codex") {
        if (
          !mightCarryUsage(line, provider) &&
          !line.includes('"turn_context"') &&
          !line.includes('"session_meta"')
        ) {
          continue;
        }
        const record = parseCodexLine(line, codexState);
        if (record !== null) records.push(record);
        continue;
      }

      if (provider === "grok") {
        if (!mightCarryUsage(line, provider)) continue;
        for (const grokRecord of parseGrokLine(line)) records.push(grokRecord);
        continue;
      }

      if (!mightCarryUsage(line, provider)) continue;
      const record = parseClaudeLine(line);
      if (record !== null) records.push(record);
    }
  } catch {
    return null;
  }

  return records;
}

/**
 * OpenCode has kept usage on assistant messages across two projections: the
 * legacy `message` table (role/model/tokens nested in `data`) and the current
 * `session_message` table (a `type` column, model under `$.model.id`). Both
 * select only usage scalars and the completed timestamp — message content
 * never leaves the database.
 */
const OPEN_CODE_MESSAGE_TABLES_QUERY = `
  SELECT name FROM sqlite_master
  WHERE type = 'table' AND name IN ('session_message', 'message')
`;

const OPEN_CODE_LEGACY_USAGE_QUERY = `
  SELECT
    id AS messageId,
    session_id AS sessionId,
    json_extract(data, '$.time.completed') AS timestampMs,
    json_extract(data, '$.modelID') AS modelId,
    json_extract(data, '$.tokens.input') AS inputTokens,
    json_extract(data, '$.tokens.output') AS outputTokens,
    json_extract(data, '$.tokens.reasoning') AS reasoningTokens,
    json_extract(data, '$.tokens.cache.read') AS cacheReadTokens,
    json_extract(data, '$.tokens.cache.write') AS cacheWriteTokens,
    json_extract(data, '$.cost') AS costUsd
  FROM message
  WHERE CASE
      WHEN json_valid(data) THEN json_extract(data, '$.time.completed')
    END >= ?
    AND CASE
      WHEN json_valid(data) THEN json_extract(data, '$.role')
    END = 'assistant'
`;

// OpenCode writes this database while usage is being read. A short busy
// timeout avoids treating a normal WAL transaction as a failed source.
const OPEN_CODE_SQLITE_BUSY_TIMEOUT_MS = 1_000;

const OPEN_CODE_CURRENT_USAGE_QUERY = `
  SELECT
    id AS messageId,
    session_id AS sessionId,
    json_extract(data, '$.time.completed') AS timestampMs,
    json_extract(data, '$.model.id') AS modelId,
    json_extract(data, '$.tokens.input') AS inputTokens,
    json_extract(data, '$.tokens.output') AS outputTokens,
    json_extract(data, '$.tokens.reasoning') AS reasoningTokens,
    json_extract(data, '$.tokens.cache.read') AS cacheReadTokens,
    json_extract(data, '$.tokens.cache.write') AS cacheWriteTokens,
    json_extract(data, '$.cost') AS costUsd
  FROM session_message
  WHERE CASE
      WHEN json_valid(data) THEN json_extract(data, '$.time.completed')
    END >= ?
    AND type = 'assistant'
`;

const OPEN_CODE_TABLE_QUERIES = {
  session_message: OPEN_CODE_CURRENT_USAGE_QUERY,
  message: OPEN_CODE_LEGACY_USAGE_QUERY,
} as const;

type OpenCodeMessageTable = keyof typeof OPEN_CODE_TABLE_QUERIES;

interface OpenCodeWorkerRows {
  readonly table: OpenCodeMessageTable;
  readonly rows: readonly OpenCodeUsageRow[];
}

type OpenCodeWorkerResult =
  | { readonly status: "ok"; readonly groups: readonly OpenCodeWorkerRows[] }
  | { readonly status: "failed" };

/**
 * Kept inline so server bundles do not need a second worker entrypoint. Only
 * usage scalars cross back to the main thread; message content stays in SQLite.
 */
const OPEN_CODE_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  const { DatabaseSync } = require("node:sqlite");

  let database;
  let result = { status: "failed" };
  try {
    database = new DatabaseSync(workerData.dbPath, {
      readOnly: true,
      timeout: workerData.busyTimeoutMs,
    });

    const tables = new Set();
    for (const row of database.prepare(workerData.tablesQuery).all()) {
      if (row.name === "session_message" || row.name === "message") tables.add(row.name);
    }
    if (tables.size > 0) {
      const groups = [];
      for (const table of ["session_message", "message"]) {
        if (!tables.has(table)) continue;
        const rows = database
          .prepare(workerData.tableQueries[table])
          .all(workerData.sinceMs)
          .map((row) => ({ ...row }));
        groups.push({ table, rows });
      }
      result = { status: "ok", groups };
    }
  } catch {
    result = { status: "failed" };
  } finally {
    try {
      database?.close();
    } catch {}
  }

  parentPort.postMessage(result);
`;

function readOpenCodeRows(
  dbPath: string,
  sinceMs: number,
): Promise<readonly OpenCodeWorkerRows[] | null> {
  return new Promise((resolve) => {
    const worker = (() => {
      try {
        return new NodeWorkerThreads.Worker(OPEN_CODE_WORKER_SOURCE, {
          eval: true,
          workerData: {
            dbPath,
            sinceMs,
            busyTimeoutMs: OPEN_CODE_SQLITE_BUSY_TIMEOUT_MS,
            tablesQuery: OPEN_CODE_MESSAGE_TABLES_QUERY,
            tableQueries: OPEN_CODE_TABLE_QUERIES,
          },
        });
      } catch {
        return null;
      }
    })();
    if (worker === null) {
      resolve(null);
      return;
    }

    let settled = false;
    const finish = (value: readonly OpenCodeWorkerRows[] | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    worker.once("message", (message: OpenCodeWorkerResult) => {
      finish(message.status === "ok" ? message.groups : null);
    });
    worker.once("error", () => finish(null));
    worker.once("exit", (code) => {
      if (code !== 0) finish(null);
    });
  });
}

/**
 * Reads usage records from OpenCode's SQLite transcript store.
 *
 * Unlike the JSONL providers, OpenCode keeps one row per message in
 * `opencode.db`, so the whole source is one query. The window filter is pushed
 * into SQL using the completed timestamp, so usage is attributed to the hour
 * or day the turn finished. The database is opened read-only, and
 * `-wal`/`-shm` siblings are never created because no write happens.
 *
 * An upgraded database can carry the same message ID in both projections; the
 * current `session_message` row wins. Returns `null` when the database cannot
 * be read, so the caller reports the source as failed rather than zero usage.
 */
export async function readOpenCodeRecords(
  dbPath: string,
  sinceMs: number,
): Promise<readonly UsageRecord[] | null> {
  const groups = await readOpenCodeRows(dbPath, sinceMs);
  if (groups === null) return null;

  const recordsByKey = new Map<string, UsageRecord>();
  let anonymous = 0;
  for (const { table, rows } of groups) {
    for (const row of rows) {
      const record = parseOpenCodeUsageRow(row);
      if (record === null) continue;
      if (record.dedupeKey === null) {
        // An anonymous record can still be unique; it just cannot dedupe
        // across the two projections.
        recordsByKey.set(`${table}#${anonymous++}`, record);
        continue;
      }
      if (!recordsByKey.has(record.dedupeKey)) {
        recordsByKey.set(record.dedupeKey, record);
      }
    }
  }
  return [...recordsByKey.values()];
}
