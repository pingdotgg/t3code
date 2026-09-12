// @effect-diagnostics nodeBuiltinImport:off
/**
 * Raw filesystem access for transcript scanning.
 *
 * Isolated here so the rest of the usage code stays on Effect's `FileSystem`.
 * The direct `node:fs` streaming is deliberate: a cold 30-day window is ~1.4 GB
 * across ~1,500 files, and buffer-level streaming is roughly an order of
 * magnitude cheaper than materialising each file. The equivalent Effect stream
 * pipeline is idiomatic but not fast enough to sit behind a page load.
 *
 * Transcripts are append-only, so a parse also reports the byte position it
 * stopped at. A later scan of the same file resumes from that position and
 * parses only the appended bytes, which is what keeps a warm scan cheap while a
 * session is actively writing a multi-hundred-megabyte rollout.
 *
 * @module usageTranscriptReader
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { UsageProviderKind } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  initialCodexScanState,
  int,
  mightCarryUsage,
  parseClaudeLine,
  parseCodexLine,
  parseCopilotLine,
  parseGrokLine,
  parseTimestampMs,
  type CodexScanState,
  type UsageRecord,
} from "./usageTranscripts.ts";

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * Where a parse stopped, with enough state to continue from there.
 *
 * The guard hash fingerprints the bytes immediately before `resumeOffset`. A
 * resume only proceeds when those bytes still match: transcripts are
 * append-only by design, but a rotated or rewritten file silently mis-parsed
 * from the middle would corrupt usage totals. The window is a cheap tripwire
 * for those realistic failure shapes, all of which disturb the file's tail at
 * that exact offset; it deliberately does not hash the whole prefix, which
 * would cost the full re-read the resume exists to avoid.
 */
export interface TranscriptParsePosition {
  /** Byte offset just past the last newline-terminated line consumed. */
  readonly resumeOffset: number;
  /** Length of the fingerprinted window ending at `resumeOffset`. */
  readonly guardLength: number;
  /** FNV-1a hash of that window. */
  readonly guardHash: number;
  /** Codex reducer state as of `resumeOffset`; `null` for stateless providers. */
  readonly codexState: CodexScanState | null;
}

export interface TranscriptParseResult {
  /** Records from newline-terminated lines at or after the parse start. */
  readonly records: readonly UsageRecord[];
  /**
   * Records from a trailing segment the writer has not newline-terminated yet.
   * Kept out of `records` because `position` deliberately excludes that
   * segment: the next scan re-reads it once the writer finishes the line.
   */
  readonly tailRecords: readonly UsageRecord[];
  readonly position: TranscriptParsePosition;
  /** Whether the parse continued from `resumeFrom` rather than byte 0. */
  readonly resumed: boolean;
}

/** 64 bytes of JSONL tail is ample to distinguish a replaced file. */
export const GUARD_LENGTH = 64;
const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

function fnv1a(buffer: Buffer): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < buffer.length; index += 1) {
    hash ^= buffer[index]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
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
  options?: { readonly fileName?: string; readonly provider?: UsageProviderKind },
): Promise<readonly TranscriptFile[]> {
  if (options?.provider === "antigravity") {
    const found: TranscriptFile[] = [];
    try {
      const entries = await NodeFSP.readdir(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".db")) {
          const dbPath = NodePath.join(root, entry.name);
          try {
            const stats = await NodeFSP.stat(dbPath);
            let effectiveMtimeMs = stats.mtimeMs;
            let effectiveSize = stats.size;
            try {
              const walStats = await NodeFSP.stat(`${dbPath}-wal`);
              effectiveMtimeMs = Math.max(effectiveMtimeMs, walStats.mtimeMs);
              effectiveSize += walStats.size;
            } catch {
              // WAL file may not exist
            }
            if (effectiveMtimeMs >= sinceMs) {
              found.push({ path: dbPath, size: effectiveSize, mtimeMs: effectiveMtimeMs });
            }
          } catch {
            // Ignore stat errors
          }
        }
      }
      return found;
    } catch {
      return [];
    }
  }

  if (options?.provider === "copilot") {
    const dbPath = NodePath.join(root, "session-store.db");
    try {
      const stats = await NodeFSP.stat(dbPath);
      let effectiveMtimeMs = stats.mtimeMs;
      let effectiveSize = stats.size;
      try {
        const walStats = await NodeFSP.stat(`${dbPath}-wal`);
        effectiveMtimeMs = Math.max(effectiveMtimeMs, walStats.mtimeMs);
        effectiveSize += walStats.size;
      } catch {
        // WAL file may not exist if never written or fully checkpointed
      }
      if (effectiveMtimeMs >= sinceMs) {
        return [{ path: dbPath, size: effectiveSize, mtimeMs: effectiveMtimeMs }];
      }
      return [];
    } catch {
      // Fall through to walk .jsonl files in session-state if session-store.db does not exist
    }
  }

  const found: TranscriptFile[] = [];
  const fileName = options?.fileName;

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
      } catch {
        // Ignore stat errors for deleted or locked files
      }
    }
  };

  await walk(root);
  return found;
}

/**
 * Returns a stable filesystem identifier for `dir` when available.
 *
 * Preserves the existing `UsageSourceFingerprint.volumeId` semantics: on POSIX
 * systems this is the device number (`stat.dev`), distinguishing two physical
 * volumes that mount at identical absolute paths.
 */
export async function readDirectoryVolumeId(path: string): Promise<string> {
  try {
    const stats = await NodeFSP.stat(path);
    return String(stats.dev);
  } catch {
    return "";
  }
}

async function guardMatches(
  handle: NodeFSP.FileHandle,
  position: TranscriptParsePosition,
): Promise<boolean> {
  if (position.guardLength <= 0 || position.guardLength > GUARD_LENGTH) return false;
  try {
    const window = Buffer.alloc(position.guardLength);
    const { bytesRead } = await handle.read(
      window,
      0,
      position.guardLength,
      position.resumeOffset - position.guardLength,
    );
    return bytesRead === position.guardLength && fnv1a(window) === position.guardHash;
  } catch {
    return false;
  }
}

/**
 * Streams one transcript and returns the usage records it contains, or `null`
 * when the file could not be read.
 *
 * Callers must not cache `null`: a transient EBUSY or ENOENT on an active file
 * under the same `(size, mtime)` key would silently drop that file's usage
 * until the file next changes.
 *
 * With `resumeFrom`, parsing continues from that position when its guard bytes
 * still match, so only appended lines are read; otherwise the whole file is
 * re-parsed from the start and `resumed` reports `false`.
 *
 * Codex carries the active model on `turn_context` lines that hold no usage of
 * their own, so those still have to pass through the reducer to keep model
 * attribution correct.
 */
export async function readTranscriptRecords(
  filePath: string,
  provider: UsageProviderKind,
  resumeFrom?: TranscriptParsePosition,
): Promise<TranscriptParseResult | null> {
  if (provider === "antigravity" && filePath.endsWith(".db")) {
    const dbRecords = readAntigravityDbRecords(filePath);
    if (dbRecords === null) return null;
    return {
      records: dbRecords,
      tailRecords: [],
      position: {
        resumeOffset: 0,
        guardLength: 0,
        guardHash: 0,
        codexState: null,
      },
      resumed: false,
    };
  }

  if (provider === "copilot" && filePath.endsWith(".db")) {
    const dbRecords = readCopilotDbRecords(filePath);
    if (dbRecords === null) return null;
    return {
      records: dbRecords,
      tailRecords: [],
      position: {
        resumeOffset: 0,
        guardLength: 0,
        guardHash: 0,
        codexState: null,
      },
      resumed: false,
    };
  }

  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(filePath, "r");
  } catch {
    return null;
  }

  try {
    let codexState = initialCodexScanState();
    let resumed = false;
    let start = 0;
    if (
      resumeFrom !== undefined &&
      resumeFrom.resumeOffset > 0 &&
      (provider !== "codex" || resumeFrom.codexState !== null) &&
      (await guardMatches(handle, resumeFrom))
    ) {
      if (resumeFrom.codexState !== null) codexState = { ...resumeFrom.codexState };
      start = resumeFrom.resumeOffset;
      resumed = true;
    }

    const parseLine = (line: string, state: CodexScanState, out: UsageRecord[]): void => {
      if (provider === "codex") {
        if (
          !mightCarryUsage(line, provider) &&
          !line.includes('"turn_context"') &&
          !line.includes('"session_meta"')
        ) {
          return;
        }
        const record = parseCodexLine(line, state);
        if (record !== null) out.push(record);
        return;
      }
      if (!mightCarryUsage(line, provider)) return;
      if (provider === "grok") {
        for (const grokRecord of parseGrokLine(line)) out.push(grokRecord);
        return;
      }
      if (provider === "copilot") {
        const record = parseCopilotLine(line);
        if (record !== null) {
          if (record.sessionId.length === 0) {
            const base = NodePath.basename(filePath, ".jsonl");
            const sessionId =
              base === "events" ? NodePath.basename(NodePath.dirname(filePath)) : base;
            out.push({ ...record, sessionId });
          } else {
            out.push(record);
          }
        }
        return;
      }
      const record = parseClaudeLine(line);
      if (record !== null) out.push(record);
    };

    const toLineString = (lineBuffer: Buffer): string => {
      const content =
        lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === CARRIAGE_RETURN
          ? lineBuffer.subarray(0, -1)
          : lineBuffer;
      return content.toString("utf8");
    };

    const records: UsageRecord[] = [];
    // Buffer-level line splitting rather than `readline`, because resuming
    // needs byte-exact offsets and decoded strings cannot provide them.
    // Newline-free chunks are collected rather than concatenated as they
    // arrive, so a single huge line costs one copy instead of one per chunk.
    let resumeOffset = start;
    let pendingChunks: Buffer[] = [];
    const stream = handle.createReadStream({
      start,
      autoClose: false,
    }) as AsyncIterable<Buffer>;
    for await (const chunk of stream) {
      if (!chunk.includes(NEWLINE)) {
        pendingChunks.push(chunk);
        continue;
      }
      const buffer: Buffer =
        pendingChunks.length === 0 ? chunk : Buffer.concat([...pendingChunks, chunk]);
      pendingChunks = [];
      let lineStart = 0;
      for (;;) {
        const newlineIndex = buffer.indexOf(NEWLINE, lineStart);
        if (newlineIndex === -1) break;
        parseLine(toLineString(buffer.subarray(lineStart, newlineIndex)), codexState, records);
        lineStart = newlineIndex + 1;
      }
      resumeOffset += lineStart;
      if (lineStart < buffer.length) pendingChunks.push(buffer.subarray(lineStart));
    }

    // A trailing segment without its newline is parsed for this result but not
    // consumed: a writer may still be appending to it, and counting a half
    // record now and its full form later would double count.
    const tailRecords: UsageRecord[] = [];
    if (pendingChunks.length > 0) {
      const pending = pendingChunks.length === 1 ? pendingChunks[0]! : Buffer.concat(pendingChunks);
      if (pending.length > 0) parseLine(toLineString(pending), { ...codexState }, tailRecords);
    }

    const guardLength = Math.min(GUARD_LENGTH, resumeOffset);
    let guardHash = 0;
    if (guardLength > 0) {
      const window = Buffer.alloc(guardLength);
      await handle.read(window, 0, guardLength, resumeOffset - guardLength);
      guardHash = fnv1a(window);
    }

    return {
      records,
      tailRecords,
      position: {
        resumeOffset,
        guardLength,
        guardHash,
        codexState: provider === "codex" ? codexState : null,
      },
      resumed,
    };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Reads usage records directly from Copilot's `session-store.db` SQLite database.
 */
export function readCopilotDbRecords(filePath: string): readonly UsageRecord[] | null {
  try {
    const db = new NodeSqlite.DatabaseSync(filePath, { readOnly: true });
    try {
      const stmt = db.prepare(`
        SELECT id, session_id, model, input_tokens, output_tokens, cache_read_tokens,
               cache_write_tokens, reasoning_tokens, created_at
        FROM assistant_usage_events
        ORDER BY id ASC
      `);
      const rows = stmt.all() as readonly Record<string, unknown>[];
      const records: UsageRecord[] = [];
      for (const row of rows) {
        const timestampMs = parseTimestampMs(row["created_at"]);
        if (timestampMs === null) continue;
        const inputTokens = int(row["input_tokens"]);
        const cachedInputTokens = int(row["cache_read_tokens"]);
        const cacheCreationTokens = int(row["cache_write_tokens"]);
        const outputTokens = int(row["output_tokens"]);
        const reasoningTokens = int(row["reasoning_tokens"]);
        const uncachedInputTokens = Math.max(
          0,
          inputTokens - cachedInputTokens - cacheCreationTokens,
        );
        records.push({
          provider: "copilot",
          timestampMs,
          model: typeof row["model"] === "string" ? row["model"] : "copilot",
          sessionId: typeof row["session_id"] === "string" ? row["session_id"] : "",
          totals: {
            uncachedInputTokens,
            cachedInputTokens,
            cacheCreationTokens,
            outputTokens,
            reasoningTokens,
          },
          reportedCostUsd: null,
          dedupeKey: `copilot:${row["session_id"]}:${row["id"]}`,
        });
      }
      return records;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function readVarint(buf: Buffer, offset: number): [value: number, nextOffset: number] {
  let res = 0;
  let multiplier = 1;
  while (offset < buf.length) {
    const b = buf[offset++];
    if (b === undefined) break;
    res += (b & 0x7f) * multiplier;
    multiplier *= 128;
    if (!(b & 0x80)) break;
    if (multiplier > Number.MAX_SAFE_INTEGER) break;
  }
  return [res, offset];
}

interface AntigravityProtoUsage {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly timestampSeconds: number;
}

export function parseAntigravityProto(raw: Uint8Array | Buffer): AntigravityProtoUsage {
  const buf = Buffer.from(raw);
  let model = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let timestampSeconds = 0;

  function parseFields(
    b: Buffer,
    onField: (tag: number, wire: number, val: number, sub: Buffer | null) => void,
  ) {
    let i = 0;
    while (i < b.length) {
      const [key, nextI] = readVarint(b, i);
      i = nextI;
      const tag = key >> 3;
      const wire = key & 7;
      if (wire === 0) {
        const [val, afterVal] = readVarint(b, i);
        i = afterVal;
        onField(tag, wire, val, null);
      } else if (wire === 2) {
        const [len, afterLen] = readVarint(b, i);
        i = afterLen;
        if (len < 0 || i + len > b.length) break;
        const sub = b.subarray(i, i + len);
        i += len;
        onField(tag, wire, 0, sub);
      } else if (wire === 1) {
        i += 8;
      } else if (wire === 5) {
        i += 4;
      } else {
        break;
      }
    }
  }

  parseFields(buf, (tag, _wire, _val, sub) => {
    if (tag === 1 && sub) {
      parseFields(sub, (tag2, _wire2, _val2, sub2) => {
        if (tag2 === 19 && sub2) {
          model = sub2.toString("utf8");
        } else if (tag2 === 4 && sub2) {
          parseFields(sub2, (tag3, _wire3, val3) => {
            if (tag3 === 2) inputTokens = val3;
            else if (tag3 === 3) outputTokens = val3;
            else if (tag3 === 9) cachedTokens = val3;
          });
        } else if (tag2 === 9 && sub2) {
          parseFields(sub2, (tag3, _wire3, _val3, sub3) => {
            if (tag3 === 4 && sub3) {
              parseFields(sub3, (tag4, _wire4, val4) => {
                if (tag4 === 1) timestampSeconds = val4;
              });
            }
          });
        }
      });
    }
  });

  return { model, inputTokens, outputTokens, cachedTokens, timestampSeconds };
}

/**
 * Reads usage records directly from Antigravity conversation SQLite databases (`*.db`).
 */
export function readAntigravityDbRecords(filePath: string): readonly UsageRecord[] | null {
  try {
    const db = new NodeSqlite.DatabaseSync(filePath, { readOnly: true });
    try {
      const stmt = db.prepare(`
        SELECT idx, data FROM gen_metadata ORDER BY idx ASC
      `);
      const rows = stmt.all() as unknown as readonly { idx: number; data: Uint8Array }[];
      const sessionId = NodePath.basename(filePath, ".db");
      const records: UsageRecord[] = [];
      for (const row of rows) {
        const proto = parseAntigravityProto(row.data);
        if (proto.inputTokens === 0 && proto.outputTokens === 0) continue;
        if (proto.timestampSeconds <= 0) continue;
        const timestampMs =
          proto.timestampSeconds > 1e11 ? proto.timestampSeconds : proto.timestampSeconds * 1000;
        const uncachedInputTokens = Math.max(0, proto.inputTokens - proto.cachedTokens);
        records.push({
          provider: "antigravity",
          timestampMs,
          model: proto.model || "gemini-3.8-flash",
          sessionId,
          totals: {
            uncachedInputTokens,
            cachedInputTokens: proto.cachedTokens,
            cacheCreationTokens: 0,
            outputTokens: proto.outputTokens,
            reasoningTokens: 0,
          },
          reportedCostUsd: null,
          dedupeKey: `antigravity:${sessionId}:${row.idx}`,
        });
      }
      return records;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}
