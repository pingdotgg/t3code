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
  parseZcodeUsageRow,
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
 * Stats a sqlite usage store, applying the same mtime prefilter as the jsonl
 * walk. The WAL participates in the fingerprint because active ZCode writes
 * can leave the main db's size and mtime unchanged until a checkpoint.
 */
export async function statSqliteUsageStore(
  filePath: string,
  sinceMs: number,
): Promise<readonly TranscriptFile[]> {
  try {
    const stats = await NodeFSP.stat(filePath);
    const walStats = await NodeFSP.stat(`${filePath}-wal`).catch(() => null);
    const size = stats.size + (walStats?.size ?? 0);
    const mtimeMs = Math.max(stats.mtimeMs, walStats?.mtimeMs ?? 0);
    return mtimeMs >= sinceMs ? [{ path: filePath, size, mtimeMs }] : [];
  } catch {
    return [];
  }
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
 * Reads every usage row from ZCode's sqlite store.
 *
 * The whole table is read rather than windowed in SQL because the scan cache
 * memoises per `(size, mtime)` independently of the requested window;
 * out-of-window rows are dropped by the aggregator. An older schema without
 * `model_usage` yields zero records; other read failures return `null` so the
 * caller does not cache a transient failure as an empty store.
 */
async function readZcodeUsageRecords(filePath: string): Promise<readonly UsageRecord[] | null> {
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = new NodeSqlite.DatabaseSync(filePath, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT id, session_id, model_id, status, started_at, completed_at,
                input_tokens, output_tokens, reasoning_tokens,
                cache_creation_input_tokens, cache_read_input_tokens
         FROM model_usage
         WHERE status = 'completed'`,
      )
      .all();
    const records: UsageRecord[] = [];
    for (const row of rows) {
      const record = parseZcodeUsageRow(row);
      if (record !== null) records.push(record);
    }
    return records;
  } catch (error) {
    return error instanceof Error && error.message.includes("no such table: model_usage")
      ? []
      : null;
  } finally {
    db?.close();
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
 *
 * ZCode never reaches line parsing: its store is sqlite, handled above.
 */
export async function readTranscriptRecords(
  filePath: string,
  provider: UsageProviderKind,
): Promise<readonly UsageRecord[] | null> {
  if (provider === "zcode") return readZcodeUsageRecords(filePath);

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
