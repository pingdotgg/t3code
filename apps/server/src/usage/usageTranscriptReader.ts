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
import * as NodeSqlite from "node:sqlite";

import type { UsageProviderKind } from "@t3tools/contracts";

import {
  initialCodexScanState,
  mightCarryUsage,
  parseClaudeLine,
  parseCodexLine,
  parseOpenCodeUsageRow,
  type OpenCodeUsageRow,
  type UsageRecord,
} from "./usageTranscripts.ts";

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * Lists `.jsonl` transcripts under `root` last modified at or after `sinceMs`.
 *
 * Errors on individual entries are swallowed: session files rotate and get
 * removed while the walk is in flight, and a partial listing is far better than
 * failing the page.
 */
export async function listTranscriptFiles(
  root: string,
  sinceMs: number,
): Promise<readonly TranscriptFile[]> {
  const found: TranscriptFile[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      try {
        const stats = await NodeFSP.stat(child);
        if (stats.mtimeMs >= sinceMs) {
          found.push({ path: child, size: stats.size, mtimeMs: stats.mtimeMs });
        }
      } catch {
        // Vanished between readdir and stat.
      }
    }
  };

  await walk(root);
  return found;
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
 * select only usage scalars — message content never leaves the database.
 */
const OPEN_CODE_MESSAGE_TABLES_QUERY = `
  SELECT name FROM sqlite_master
  WHERE type = 'table' AND name IN ('session_message', 'message')
`;

const OPEN_CODE_LEGACY_USAGE_QUERY = `
  SELECT
    id AS messageId,
    session_id AS sessionId,
    time_created AS timestampMs,
    json_extract(data, '$.modelID') AS modelId,
    json_extract(data, '$.tokens.input') AS inputTokens,
    json_extract(data, '$.tokens.output') AS outputTokens,
    json_extract(data, '$.tokens.reasoning') AS reasoningTokens,
    json_extract(data, '$.tokens.cache.read') AS cacheReadTokens,
    json_extract(data, '$.tokens.cache.write') AS cacheWriteTokens,
    json_extract(data, '$.cost') AS costUsd
  FROM message
  WHERE time_updated >= ?
    AND json_valid(data)
    AND json_extract(data, '$.role') = 'assistant'
    AND json_extract(data, '$.time.completed') IS NOT NULL
`;

const OPEN_CODE_CURRENT_USAGE_QUERY = `
  SELECT
    id AS messageId,
    session_id AS sessionId,
    time_created AS timestampMs,
    json_extract(data, '$.model.id') AS modelId,
    json_extract(data, '$.tokens.input') AS inputTokens,
    json_extract(data, '$.tokens.output') AS outputTokens,
    json_extract(data, '$.tokens.reasoning') AS reasoningTokens,
    json_extract(data, '$.tokens.cache.read') AS cacheReadTokens,
    json_extract(data, '$.tokens.cache.write') AS cacheWriteTokens,
    json_extract(data, '$.cost') AS costUsd
  FROM session_message
  WHERE time_created >= ?
    AND type = 'assistant'
    AND json_valid(data)
`;

const OPEN_CODE_TABLE_QUERIES = {
  session_message: OPEN_CODE_CURRENT_USAGE_QUERY,
  message: OPEN_CODE_LEGACY_USAGE_QUERY,
} as const;

type OpenCodeMessageTable = keyof typeof OPEN_CODE_TABLE_QUERIES;

/**
 * Reads usage records from OpenCode's SQLite transcript store.
 *
 * Unlike the JSONL providers, OpenCode keeps one row per message in
 * `opencode.db`, so the whole source is one query. The window filter is pushed
 * into SQL (`time_updated` on the legacy table covers messages created before
 * the window but completed inside it). The database is opened read-only, and
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
  let database: NodeSqlite.DatabaseSync;
  try {
    database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }

  try {
    const tables = new Set<OpenCodeMessageTable>();
    for (const row of database.prepare(OPEN_CODE_MESSAGE_TABLES_QUERY).all()) {
      const name = (row as Record<string, unknown>)["name"];
      if (name === "session_message" || name === "message") tables.add(name);
    }
    if (tables.size === 0) return null;

    const recordsByKey = new Map<string, UsageRecord>();
    let anonymous = 0;
    for (const table of ["session_message", "message"] as const) {
      if (!tables.has(table)) continue;
      const rows = database.prepare(OPEN_CODE_TABLE_QUERIES[table]).all(sinceMs);
      for (const row of rows) {
        const record = parseOpenCodeUsageRow(row as OpenCodeUsageRow);
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
  } catch {
    return null;
  } finally {
    database.close();
  }
}
