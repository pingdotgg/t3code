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
  parseOpenCodeMessage,
  type UsageRecord,
} from "./usageTranscripts.ts";

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * Identity of an OpenCode WAL sidecar file. OpenCode runs its session store in
 * WAL mode, so fresh writes live in `opencode.db-wal` until a checkpoint folds
 * them into the main file; both must be part of any cache identity or a live
 * session is served stale.
 */
export interface OpenCodeWalIdentity {
  readonly size: number;
  readonly mtimeMs: number;
}

/** OpenCode's store is a single SQLite file; the WAL is its live tail. */
export interface OpenCodeStoreFile extends TranscriptFile {
  readonly wal: OpenCodeWalIdentity | null;
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
 * Lists OpenCode's SQLite session store under `root`, if present.
 *
 * A single `opencode.db` file replaces the transcript directory the other
 * providers use. Its mtime alone does not reflect a live session: WAL-mode
 * writes land in `opencode.db-wal` first, so the file is admitted when either
 * the main file or its WAL was touched inside the window. The WAL identity
 * rides along so the caller can cache on the store's true state.
 */
export async function listOpenCodeDatabaseFiles(
  root: string,
  sinceMs: number,
): Promise<readonly OpenCodeStoreFile[]> {
  const dbPath = NodePath.join(root, "opencode.db");
  let dbStats;
  try {
    dbStats = await NodeFSP.stat(dbPath);
  } catch {
    return [];
  }

  let wal: OpenCodeWalIdentity | null = null;
  try {
    const walStats = await NodeFSP.stat(`${dbPath}-wal`);
    wal = { size: walStats.size, mtimeMs: walStats.mtimeMs };
  } catch {
    // No sidecar (yet); a checkpointed store is complete without one.
  }

  const mtimeMs = Math.max(dbStats.mtimeMs, wal?.mtimeMs ?? 0);
  if (mtimeMs < sinceMs) return [];
  return [{ path: dbPath, size: dbStats.size, mtimeMs, wal }];
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
  if (provider === "opencode") return readOpenCodeRecords(filePath);

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
 * Reads every assistant usage record from OpenCode's SQLite session store.
 *
 * `node:sqlite` is used read-only so the CLI can hold the store open in WAL
 * mode; committed writes in the WAL are visible to a reader. A failure to open
 * or query (missing file, busy, corrupt) returns `null` so the caller's cache
 * stays untouched and the source reports empty rather than crashing the page.
 */
export async function readOpenCodeRecords(dbPath: string): Promise<readonly UsageRecord[] | null> {
  let database: NodeSqlite.DatabaseSync;
  try {
    database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }

  try {
    const rows = database.prepare("SELECT id, session_id, time_created, data FROM message").all();
    const records: UsageRecord[] = [];
    for (const row of rows as Array<Record<string, unknown>>) {
      const id = row["id"];
      const data = row["data"];
      if (typeof id !== "string" || typeof data !== "string") continue;
      const record = parseOpenCodeMessage({
        id,
        sessionId: typeof row["session_id"] === "string" ? row["session_id"] : "",
        timeCreatedMs: typeof row["time_created"] === "number" ? row["time_created"] : 0,
        data,
      });
      if (record !== null) records.push(record);
    }
    return records;
  } catch {
    return null;
  } finally {
    try {
      database.close();
    } catch {
      // Already closed.
    }
  }
}
