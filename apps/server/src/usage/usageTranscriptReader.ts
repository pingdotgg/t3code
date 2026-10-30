// @effect-diagnostics nodeBuiltinImport:off
// Cold windows span ~1.4 GB/1,500 files; node:fs buffer streaming is ~10x cheaper than materializing files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStringDecoder from "node:string_decoder";
import * as NodeZlib from "node:zlib";

import type {
  SelectedFields,
  TranscriptUsageFormat,
  UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { createTranscriptJsonReader } from "../project/AgentSessionJson.ts";

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/** Resume only if bytes before resumeOffset match the guard hash; rewritten files would corrupt totals. */
export interface TranscriptParsePosition {
  readonly resumeOffset: number;
  readonly guardLength: number;
  readonly guardHash: number;
  readonly state: unknown;
}

export interface TranscriptParseResult {
  readonly records: readonly UsageRecord[];
  /** Unterminated tail records stay outside records/position so the next scan rereads them. */
  readonly tailRecords: readonly UsageRecord[];
  /** Includes tentative tail diagnostics; position.state only includes committed lines. */
  readonly malformedRecords: number;
  readonly position: TranscriptParsePosition;
  readonly resumed: boolean;
}

export const GUARD_LENGTH = 64;
const STREAMING_THRESHOLD_BYTES = 8 * 1024 * 1024;
const NEWLINE = 0x0a;
const STAT_CONCURRENCY = 32;
const CARRIAGE_RETURN = 0x0d;

function selectUsageFields(fields: SelectedFields) {
  return (path: ReadonlyArray<string | number | null>): boolean => {
    let selected: true | SelectedFields = fields;
    for (const key of path) {
      if (selected === true) return true;
      if (typeof key !== "string" || !Object.hasOwn(selected, key)) return false;
      selected = selected[key]!;
    }
    return true;
  };
}

function fnv1a(buffer: Buffer): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < buffer.length; index += 1) {
    hash ^= buffer[index]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Skips Grok logs without usage; preserves readdir order for first-seen deduplication. */
export async function listTranscriptFiles(
  root: string,
  sinceMs: number,
  options?: { readonly fileName?: string },
): Promise<{ readonly files: readonly TranscriptFile[]; readonly failedPaths: number }> {
  const fileName = options?.fileName;
  const candidates: string[] = [];
  let failedPaths = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch {
      failedPaths += 1;
      return;
    }
    for (const entry of entries) {
      const child = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (
        fileName !== undefined
          ? entry.name === fileName
          : entry.name.endsWith(".jsonl") || entry.name.endsWith(".jsonl.zst")
      ) {
        candidates.push(child);
      }
    }
  };
  await walk(root);

  const found: Array<TranscriptFile | undefined> = Array.from({ length: candidates.length });
  const queue = candidates.entries();
  const statQueued = async (): Promise<void> => {
    for (const [index, path] of queue) {
      try {
        const stats = await NodeFSP.stat(path);
        if (stats.mtimeMs >= sinceMs) {
          found[index] = { path, size: stats.size, mtimeMs: stats.mtimeMs };
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          failedPaths += 1;
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(STAT_CONCURRENCY, candidates.length) }, statQueued),
  );
  return { files: found.filter((file) => file !== undefined), failedPaths };
}

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

// Match markers in one latin1 alternation; one character per byte preserves exact ASCII offsets.
export function transcriptLineGate(markers: readonly [string, ...string[]]) {
  if (markers.length === 1) {
    const marker = Buffer.from(markers[0]);
    return (line: Buffer) => line.includes(marker);
  }
  const pattern = new RegExp(
    markers.map((marker) => marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  );
  return (line: Buffer) => pattern.test(line.toString("latin1"));
}

/** Returns null on read failure; caching it as empty would hide usage until size/mtime changes. */
export async function readTranscriptRecords<State>(
  filePath: string,
  format: TranscriptUsageFormat<State>,
  resumeFrom?: TranscriptParsePosition,
  options?: { readonly streamingThresholdBytes?: number },
): Promise<TranscriptParseResult | null> {
  const streamingThresholdBytes = options?.streamingThresholdBytes ?? STREAMING_THRESHOLD_BYTES;
  const compressed = filePath.endsWith(".jsonl.zst");
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(filePath, "r");
  } catch {
    return null;
  }

  try {
    const codec = format.state;
    const decodeState = codec === undefined ? undefined : Schema.decodeUnknownOption(codec.schema);
    const encodeState = codec === undefined ? undefined : Schema.encodeSync(codec.schema);
    let state = codec === undefined ? (undefined as State) : codec.initial();
    let resumed = false;
    let start = 0;
    const savedState =
      resumeFrom === undefined || decodeState === undefined || resumeFrom.state === null
        ? Option.none()
        : decodeState(resumeFrom.state);
    if (
      !compressed &&
      resumeFrom !== undefined &&
      resumeFrom.resumeOffset > 0 &&
      (codec === undefined || Option.isSome(savedState)) &&
      (await guardMatches(handle, resumeFrom))
    ) {
      if (Option.isSome(savedState)) state = savedState.value;
      start = resumeFrom.resumeOffset;
      resumed = true;
    }

    const toLineString = (lineBuffer: Buffer): string => {
      const content =
        lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === CARRIAGE_RETURN
          ? lineBuffer.subarray(0, -1)
          : lineBuffer;
      return content.toString("utf8");
    };

    const mightCarryUsage = transcriptLineGate(format.usageMarkers);
    const parseLine = (lineBuffer: Buffer, lineState: State, out: UsageRecord[]): void => {
      if (!mightCarryUsage(lineBuffer)) return;
      for (const record of format.parseLine(toLineString(lineBuffer), lineState)) out.push(record);
    };

    const records: UsageRecord[] = [];
    let resumeOffset = start;
    let scanOffset = start;
    let pendingChunks: Buffer[] = [];
    let pendingBytes = 0;
    let streaming: ReturnType<typeof createTranscriptJsonReader> | undefined;
    let decoder: NodeStringDecoder.StringDecoder | undefined;
    const selectPath = selectUsageFields(format.selectFields);

    const append = (segment: Buffer) => {
      if (!streaming && pendingBytes + segment.length <= streamingThresholdBytes) {
        if (segment.length > 0) pendingChunks.push(segment);
        pendingBytes += segment.length;
        return;
      }
      if (!streaming) {
        // Usage has no import-history budget; retain selected fields regardless of surrounding tool payload size.
        streaming = createTranscriptJsonReader(() => {}, selectPath, { maxDepth: Infinity });
        decoder = new NodeStringDecoder.StringDecoder("utf8");
        for (const pending of pendingChunks) streaming.write(decoder.write(pending));
        pendingChunks = [];
        pendingBytes = 0;
      }
      streaming.write(decoder!.write(segment));
    };
    const finish = (lineState: State, out: UsageRecord[]) => {
      if (streaming) {
        streaming.write(decoder!.end());
        const projected = streaming.finish();
        for (const record of format.parseProjected(projected, lineState)) out.push(record);
      } else if (pendingBytes > 0) {
        const line =
          pendingChunks.length === 1
            ? pendingChunks[0]!
            : Buffer.concat(pendingChunks, pendingBytes);
        parseLine(line, lineState, out);
      }
      pendingChunks = [];
      pendingBytes = 0;
      streaming = undefined;
      decoder = undefined;
    };
    const input = handle.createReadStream({
      start,
      autoClose: compressed,
      highWaterMark: 256 * 1024,
    });
    // Compressed snapshots cache a full parse; decoded byte offsets cannot
    // resume the compressed input.
    const stream = compressed ? input.compose(NodeZlib.createZstdDecompress()) : input;
    for await (const chunk of stream) {
      let lineStart = 0;
      while (lineStart < chunk.length) {
        const newlineIndex = chunk.indexOf(NEWLINE, lineStart);
        if (newlineIndex === -1) {
          append(chunk.subarray(lineStart));
          break;
        }
        if (!streaming && pendingBytes === 0) {
          parseLine(chunk.subarray(lineStart, newlineIndex), state, records);
        } else {
          append(chunk.subarray(lineStart, newlineIndex));
          finish(state, records);
        }
        lineStart = newlineIndex + 1;
        resumeOffset = scanOffset + lineStart;
      }
      scanOffset += chunk.length;
    }

    // Parse unfinished tails against copied state so the next scan can replay from resumeOffset.
    const encodedState = encodeState === undefined ? null : encodeState(state);
    const tailRecords: UsageRecord[] = [];
    const tailState =
      decodeState === undefined ? state : Option.getOrThrow(decodeState(encodedState));
    finish(tailState, tailRecords);

    const guardLength = compressed ? 0 : Math.min(GUARD_LENGTH, resumeOffset);
    let guardHash = 0;
    if (guardLength > 0) {
      const window = Buffer.alloc(guardLength);
      await handle.read(window, 0, guardLength, resumeOffset - guardLength);
      guardHash = fnv1a(window);
    }

    return {
      records,
      tailRecords,
      malformedRecords: format.readMalformedRecords?.(tailState) ?? 0,
      position: {
        resumeOffset: compressed ? 0 : resumeOffset,
        guardLength,
        guardHash,
        state: encodedState,
      },
      resumed,
    };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
