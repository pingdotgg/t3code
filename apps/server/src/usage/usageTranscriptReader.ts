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
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { UsageProviderKind } from "@t3tools/contracts";

import {
  initialCodexScanState,
  mightCarryUsage,
  parseClaudeLineRecords,
  parseCodexLine,
  parseGrokLine,
  type CodexScanState,
  type UsageRecord,
} from "./usageTranscripts.ts";

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface TranscriptFileIdentity {
  readonly sessionId: string;
  readonly cwd: string;
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
  options?: {
    readonly fileName?: string;
    readonly onFile?: (path: string) => void;
  },
): Promise<readonly TranscriptFile[]> {
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
      options?.onFile?.(child);
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

const IDENTITY_MAX_BYTES = 256 * 1024;
const IDENTITY_MAX_LINES = 100;

/** Reads only the bounded Codex preamble needed to identify a rollout. */
export async function readCodexTranscriptIdentity(
  filePath: string,
): Promise<TranscriptFileIdentity | null> {
  let stream: NodeFS.ReadStream | null = null;
  try {
    stream = NodeFS.createReadStream(filePath, {
      encoding: "utf8",
      highWaterMark: 16 * 1024,
    });
    let pending = "";
    let bytesRead = 0;
    let linesRead = 0;
    for await (const chunk of stream) {
      const text = String(chunk);
      bytesRead += Buffer.byteLength(text);
      if (bytesRead > IDENTITY_MAX_BYTES) return null;
      pending += text;
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline === -1) break;
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        linesRead += 1;
        if (linesRead > IDENTITY_MAX_LINES) return null;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof parsed !== "object" || parsed === null) continue;
        const record = parsed as Record<string, unknown>;
        if (record["type"] !== "session_meta") continue;
        const payload = record["payload"];
        if (typeof payload !== "object" || payload === null) return null;
        const meta = payload as Record<string, unknown>;
        const sessionId = meta["id"] ?? meta["session_id"];
        return {
          sessionId: typeof sessionId === "string" ? sessionId : "",
          cwd: typeof meta["cwd"] === "string" ? meta["cwd"] : "",
        };
      }
    }
    return null;
  } finally {
    stream?.destroy();
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
 * The distinction matters to the caller's cache: a genuinely empty transcript
 * is a stable fact worth memoising, while a transient read failure memoised
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
      for (const record of parseClaudeLineRecords(line)) out.push(record);
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

/** Prefixes that mark an injected preamble, not something the user typed. */
const NOT_TITLE_PREFIXES = [
  "<system-reminder>",
  "<command-message>",
  "<command-name>",
  "<local-command-caveat>",
  "<user_shell_command>",
  "<environment_context>",
  "<INSTRUCTIONS>",
  "# AGENTS.md instructions",
  "Caveat: the messages below",
];

const TITLE_MAX_LENGTH = 80;
const TITLE_MAX_LINES = 400;
const TITLE_MAX_BYTES = 1024 * 1024;

function cleanTitle(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const collapsed = text.split(/\s+/).join(" ").trim();
  if (collapsed.length === 0) return null;
  if (NOT_TITLE_PREFIXES.some((prefix) => collapsed.startsWith(prefix))) return null;
  const characters = Array.from(collapsed);
  return characters.length > TITLE_MAX_LENGTH
    ? `${characters.slice(0, TITLE_MAX_LENGTH - 1).join("")}\u2026`
    : collapsed;
}

function claudeTitleFromLine(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "user") return null;
  const message = record["message"];
  if (typeof message !== "object" || message === null) return null;
  const content = (message as Record<string, unknown>)["content"];
  if (typeof content === "string") return cleanTitle(content);
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const entry = block as Record<string, unknown>;
    if (entry["type"] !== "text") continue;
    const title = cleanTitle(entry["text"]);
    if (title !== null) return title;
  }
  return null;
}

function codexTitleFromLine(
  line: string,
): { readonly title: string; readonly timestampMs: number | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const payload = (parsed as Record<string, unknown>)["payload"];
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (record["type"] !== "message" || record["role"] !== "user") return null;
  const content = record["content"];
  if (!Array.isArray(content)) return null;
  const timestamp = (parsed as Record<string, unknown>)["timestamp"];
  const parsedTimestamp = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
  const timestampMs = Number.isNaN(parsedTimestamp) ? null : parsedTimestamp;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const title = cleanTitle((block as Record<string, unknown>)["text"]);
    if (title !== null) return { title, timestampMs };
  }
  return null;
}

/**
 * First thing the user actually typed in a session, as a display title.
 *
 * Only called for the handful of unattributed rows that survived the response
 * cap, so a second bounded read per row is fine. Returns null when the file
 * cannot be read, holds no user text (Grok logs carry none we trust), or only
 * injected preambles appear early on.
 */
export async function readTranscriptTitle(
  filePath: string,
  provider: UsageProviderKind,
): Promise<string | null> {
  if (provider === "grok") return null;
  const codexState = provider === "codex" ? initialCodexScanState() : null;
  let stream: NodeFS.ReadStream | null = null;
  try {
    stream = NodeFS.createReadStream(filePath, { encoding: "utf8" });
    let pending = "";
    let seen = 0;
    let bytesRead = 0;
    for await (const chunk of stream) {
      const text = String(chunk);
      bytesRead += Buffer.byteLength(text);
      pending += text;
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline === -1) break;
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        seen += 1;
        if (seen > TITLE_MAX_LINES) return null;
        if (provider === "claude") {
          if (!line.includes('"user"')) continue;
          const title = claudeTitleFromLine(line);
          if (title !== null) return title;
          continue;
        }
        const title = codexTitleFromLine(line);
        parseCodexLine(line, codexState!);
        if (title === null) continue;
        if (!codexState!.suppressingForkCopies) return title.title;
        if (title.timestampMs !== null) {
          if (title.timestampMs - codexState!.forkCopyAnchorMs >= 1000) return title.title;
          codexState!.forkCopyAnchorMs = title.timestampMs;
        }
      }
      if (bytesRead >= TITLE_MAX_BYTES) return null;
    }
    if (pending.length > 0 && seen < TITLE_MAX_LINES) {
      if (provider === "claude") return claudeTitleFromLine(pending);
      const title = codexTitleFromLine(pending);
      parseCodexLine(pending, codexState!);
      if (title === null) return null;
      if (!codexState!.suppressingForkCopies) return title.title;
      if (title.timestampMs === null) return null;
      if (title.timestampMs - codexState!.forkCopyAnchorMs >= 1000) return title.title;
      codexState!.forkCopyAnchorMs = title.timestampMs;
      return null;
    }
  } catch {
    return null;
  } finally {
    stream?.destroy();
  }
  return null;
}
