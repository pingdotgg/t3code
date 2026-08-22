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
  parseMcodeUsageRow,
  type UsageRecord,
} from "./usageTranscripts.ts";

/** Wait through brief writer locks without stalling the server indefinitely. */
const MCODE_BUSY_TIMEOUT_MS = 1_000;

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface TranscriptListing {
  readonly files: readonly TranscriptFile[];
  readonly failedEntries: number;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
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
): Promise<TranscriptListing> {
  const found: TranscriptFile[] = [];
  let failedEntries = 0;

  const walk = async (dir: string, isRoot = false): Promise<void> => {
    let entries;
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch (error) {
      // A nested entry may rotate away between its parent readdir and this
      // walk. The root disappearing after the caller's existence check is a
      // real source failure, as is any permission or I/O error.
      if (isRoot || errorCode(error) !== "ENOENT") failedEntries += 1;
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
      } catch (error) {
        // Vanishing between readdir and stat is benign rotation; other errors
        // mean coverage is partial.
        if (errorCode(error) !== "ENOENT") failedEntries += 1;
      }
    }
  };

  await walk(root, true);
  return { files: found, failedEntries };
}

/**
 * Stats a SQLite usage store with its WAL so active writes invalidate cache
 * entries even before the main database checkpoints.
 */
export async function statSqliteUsageStore(
  filePath: string,
  sinceMs: number,
): Promise<readonly TranscriptFile[] | null> {
  try {
    const stats = await NodeFSP.stat(filePath);
    const walStats = await NodeFSP.stat(`${filePath}-wal`).catch(() => null);
    const size = stats.size + (walStats?.size ?? 0);
    const mtimeMs = Math.max(stats.mtimeMs, walStats?.mtimeMs ?? 0);
    return mtimeMs >= sinceMs ? [{ path: filePath, size, mtimeMs }] : [];
  } catch {
    return null;
  }
}

/** Whether a candidate MCode database contains the canonical accounting table. */
export async function hasMcodeUsageTable(filePath: string): Promise<boolean> {
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = new NodeSqlite.DatabaseSync(filePath, {
      readOnly: true,
      timeout: MCODE_BUSY_TIMEOUT_MS,
    });
    return (
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
        .get("local_runtime_token_usage") !== undefined
    );
  } catch {
    return false;
  } finally {
    db?.close();
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

/** Reads MCode's indexed, per-request token accounting rows. */
async function readMcodeUsageRecords(
  filePath: string,
  sinceMs: number,
): Promise<readonly UsageRecord[] | null> {
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = new NodeSqlite.DatabaseSync(filePath, {
      readOnly: true,
      timeout: MCODE_BUSY_TIMEOUT_MS,
    });
    const rows = db
      .prepare(
        `SELECT id, session_id, model, ts,
                input_tokens, output_tokens, reasoning_tokens,
                cache_read_tokens, cache_write_tokens, cost_usd
         FROM local_runtime_token_usage
         WHERE ts >= ?
         ORDER BY ts, id`,
      )
      .iterate(sinceMs);
    const records: UsageRecord[] = [];
    for (const row of rows) {
      const record = parseMcodeUsageRow(row);
      if (record !== null) records.push(record);
    }
    return records;
  } catch (error) {
    return error instanceof Error &&
      error.message.includes("no such table: local_runtime_token_usage")
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
 */
export async function readTranscriptRecords(
  filePath: string,
  provider: UsageProviderKind,
  mcodeSinceMs = 0,
): Promise<readonly UsageRecord[] | null> {
  if (provider === "mcode") return readMcodeUsageRecords(filePath, mcodeSinceMs);

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
