// @effect-diagnostics nodeBuiltinImport:off
/**
 * Codex transcript recovery for account limits.
 *
 * Codex writes its full rate-limit snapshot beside every `token_count` line in
 * `~/.codex/sessions/**\/*.jsonl`, so the latest snapshot survives on disk even
 * when no session has run through T3 Code. Claude has no equivalent: its
 * limits exist only on the live SDK stream.
 *
 * Only file tails are read: the newest lines carry the newest snapshot, and a
 * session file can be tens of megabytes. Direct `node:fs` is deliberate, same
 * as `usageTranscriptReader`: this is bulk raw-file access on a request path.
 *
 * @module accountLimitsTranscripts
 */
import * as NodeFSP from "node:fs/promises";

import {
  codexSnapshotFromUnknown,
  isPrimaryCodexLimit,
  type CodexRateLimitsSnapshot,
} from "./accountLimitsNormalize.ts";
import { listTranscriptFiles } from "./usageTranscriptReader.ts";

const TAIL_BYTES = 256 * 1024;
const SCAN_WINDOW_DAYS = 14;
/**
 * Newest-first cutoff bounding the scan on the RPC path. The newest file
 * almost always hits; the margin covers runs of files without a main-meter
 * snapshot (Spark-only sessions, sessions abandoned before any token count).
 * If this many consecutive files lack one, the data is genuinely absent.
 */
const MAX_FILES = 32;

export interface CodexTranscriptRateLimits {
  readonly snapshot: CodexRateLimitsSnapshot;
  readonly asOfMs: number;
}

export async function readLatestCodexRateLimits(
  sessionsDir: string,
  nowMs: number,
): Promise<CodexTranscriptRateLimits | null> {
  let files;
  try {
    files = await listTranscriptFiles(sessionsDir, nowMs - SCAN_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  } catch {
    return null;
  }
  const newestFirst = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_FILES);
  // The newest-mtime file does not necessarily hold the newest snapshot: a
  // session can keep appending non-token events after its last rate-limit
  // line. A file's snapshot can never be newer than the file's mtime, so
  // keep scanning only while a remaining file's mtime could still beat the
  // best snapshot found - which usually stops after one or two files.
  let best: CodexTranscriptRateLimits | null = null;
  for (const file of newestFirst) {
    if (best !== null && file.mtimeMs <= best.asOfMs) break;
    const found = await readTailRateLimits(file.path, file.mtimeMs);
    if (found !== null && (best === null || found.asOfMs > best.asOfMs)) best = found;
  }
  return best;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readTailRateLimits(
  filePath: string,
  mtimeMs: number,
): Promise<CodexTranscriptRateLimits | null> {
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(filePath, "r");
  } catch {
    return null;
  }
  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const length = stat.size - start;
    if (length <= 0) return null;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);

    // The first line may be cut mid-record by the tail offset; JSON.parse
    // rejects it and the scan moves on.
    const lines = buffer.toString("utf8").split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line || !line.includes('"rate_limits"')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(parsed)) continue;
      const payload = isRecord(parsed.payload) ? parsed.payload : null;
      if (!payload) continue;
      const snapshot = codexSnapshotFromUnknown(payload.rate_limits);
      // Side meters (Spark) write their own snapshot lines; keep scanning
      // back for the main meter.
      if (!snapshot || !isPrimaryCodexLimit(snapshot.limitId) || snapshot.windows.length === 0) {
        continue;
      }
      const timestamp =
        typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : Number.NaN;
      return { snapshot, asOfMs: Number.isFinite(timestamp) ? timestamp : mtimeMs };
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}
