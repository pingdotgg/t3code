// @effect-diagnostics nodeBuiltinImport:off
/**
 * Raw filesystem access for transcript scanning.
 *
 * Isolated here so the rest of the usage code stays on Effect's `FileSystem`.
 * The direct `node:fs` streaming is deliberate: a cold 30-day window is ~1.4 GB
 * across ~1,500 files, and scanning a read stream is roughly an order of
 * magnitude cheaper than materialising each file. The equivalent Effect stream
 * pipeline is idiomatic but not fast enough to sit behind a page load. The
 * byte-oriented line reader also lets us discard pathological records before
 * constructing a string that could cross V8's maximum length.
 *
 * @module usageTranscriptReader
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { UsageProviderKind } from "@t3tools/contracts";

import {
  initialCodexScanState,
  mightCarryUsage,
  parseClaudeLine,
  parseCodexLine,
  type UsageRecord,
} from "./usageTranscripts.ts";

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface TranscriptReadOptions {
  /** Maximum UTF-8 bytes retained for one JSONL record before it is skipped. */
  readonly maxLineBytes?: number;
}

/**
 * Well above observed valid provider records while remaining safely below
 * V8's maximum string length. Usage-bearing records are ordinarily tiny; the
 * largest transcript lines are tool outputs and embedded media.
 */
const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;

function decodeLine(chunks: readonly Buffer[], byteLength: number): string {
  const bytes = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, byteLength);
  const end = bytes?.[byteLength - 1] === 0x0d ? byteLength - 1 : byteLength;
  return bytes?.toString("utf8", 0, end) ?? "";
}

/**
 * Streams newline-delimited UTF-8 without ever retaining an unbounded record.
 *
 * Node's `readline` concatenates a whole line before yielding it. A rollout
 * can legitimately contain a huge tool result on one line, which lets that
 * internal string cross V8's limit and terminate the process before the
 * caller's `try/catch` can run. Once a line crosses this reader's limit, its
 * remaining bytes are drained through the next newline and scanning resumes.
 */
async function* readBoundedLines(
  filePath: string,
  maxLineBytes: number,
): AsyncGenerator<string, void> {
  const input = NodeFS.createReadStream(filePath);
  let chunks: Buffer[] = [];
  let byteLength = 0;
  let discarding = false;

  for await (const rawChunk of input) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    let start = 0;

    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      const segmentLength = end - start;

      if (!discarding && segmentLength > 0) {
        if (byteLength + segmentLength <= maxLineBytes) {
          chunks.push(chunk.subarray(start, end));
          byteLength += segmentLength;
        } else {
          chunks = [];
          byteLength = 0;
          discarding = true;
        }
      }

      if (newline === -1) break;

      if (!discarding) {
        const line = decodeLine(chunks, byteLength);
        chunks = [];
        byteLength = 0;
        yield line;
      } else {
        chunks = [];
        byteLength = 0;
        discarding = false;
      }
      start = newline + 1;
    }
  }

  if (!discarding && byteLength > 0) {
    yield decodeLine(chunks, byteLength);
  }
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
  options: TranscriptReadOptions = {},
): Promise<readonly UsageRecord[] | null> {
  const records: UsageRecord[] = [];
  const codexState = initialCodexScanState();

  try {
    const lines = readBoundedLines(filePath, options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES);

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
