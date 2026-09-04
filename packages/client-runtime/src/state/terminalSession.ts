import {
  type EnvironmentId,
  type TerminalAttachStreamEvent,
  type TerminalMetadataStreamEvent,
  type TerminalSessionSnapshot,
  type TerminalSummary,
  type ThreadId,
} from "@t3tools/contracts";
import { splitStringByUtf8Bytes } from "@t3tools/shared/utf8";

export interface TerminalOutputChunk {
  readonly id: number;
  readonly data: string;
  readonly byteLength: number;
  readonly delivery: "replay" | "live";
}

export interface TerminalOutputState {
  readonly chunks: ReadonlyArray<TerminalOutputChunk>;
  readonly retainedBytes: number;
  readonly resetVersion: number;
  readonly latestChunkId: number;
  /**
   * Highest chunk id that has been folded into a merged chunk. Ids at or below
   * this value may span several original chunks, so a cursor pointing below it
   * can no longer prove it sits on a chunk boundary and must resynchronize.
   */
  readonly compactedThroughId: number;
}

export interface TerminalOutputCursor {
  readonly resetVersion: number;
  readonly lastChunkId: number;
}

/** Forces the first `readTerminalOutputUpdate` to resynchronize from a reset. */
export const INITIAL_TERMINAL_OUTPUT_CURSOR = Object.freeze<TerminalOutputCursor>({
  resetVersion: -1,
  lastChunkId: 0,
});

export type TerminalOutputUpdate =
  | {
      readonly type: "none";
      readonly cursor: TerminalOutputCursor;
    }
  | {
      readonly type: "reset";
      readonly data: string;
      readonly cursor: TerminalOutputCursor;
    }
  | {
      readonly type: "append";
      readonly cursor: TerminalOutputCursor;
      readonly segments: ReadonlyArray<{
        readonly data: string;
        readonly delivery: "replay" | "live";
      }>;
    };

export interface TerminalSessionState {
  readonly summary: TerminalSummary | null;
  readonly output: TerminalOutputState;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly hasRunningSubprocess: boolean;
  readonly updatedAt: string | null;
  readonly replayStartVersion: number;
  readonly replayCompleteVersion: number;
  readonly version: number;
  readonly lifecycleVersion: number;
}

export interface TerminalBufferState {
  readonly output: TerminalOutputState;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly updatedAt: string | null;
  readonly replayStartVersion: number;
  readonly replayCompleteVersion: number;
  readonly version: number;
  readonly lifecycleVersion: number;
}

export interface KnownTerminalSessionTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

export interface KnownTerminalSession {
  readonly target: KnownTerminalSessionTarget;
  readonly state: TerminalSessionState;
}

export function selectRunningSubprocessTerminalIds(
  sessions: ReadonlyArray<KnownTerminalSession>,
): ReadonlyArray<string> {
  return sessions
    .filter((session) => session.state.hasRunningSubprocess)
    .map((session) => session.target.terminalId);
}

export const EMPTY_TERMINAL_BUFFER_STATE = Object.freeze<TerminalBufferState>({
  output: Object.freeze({
    chunks: Object.freeze([]),
    retainedBytes: 0,
    resetVersion: 0,
    latestChunkId: 0,
    compactedThroughId: 0,
  }),
  status: "closed",
  error: null,
  updatedAt: null,
  replayStartVersion: 0,
  replayCompleteVersion: 0,
  version: 0,
  lifecycleVersion: 0,
});

// Each attach stream run gets its own resetVersion epoch. A rebuilt scan state
// (registry entry reinstall, connection hand-off) must never alias a cursor a
// renderer took from the previous run, or the renderer silently drops output.
const TERMINAL_ATTACH_EPOCH_STRIDE = 2 ** 32;
let terminalAttachEpoch = 0;

/** Seed state for one run of the attach stream's scan. */
export function nextTerminalAttachSeedState(): TerminalBufferState {
  terminalAttachEpoch += 1;
  return {
    ...EMPTY_TERMINAL_BUFFER_STATE,
    output: {
      ...EMPTY_TERMINAL_BUFFER_STATE.output,
      resetVersion: terminalAttachEpoch * TERMINAL_ATTACH_EPOCH_STRIDE,
    },
  };
}

export const EMPTY_TERMINAL_SESSION_STATE = Object.freeze<TerminalSessionState>({
  summary: null,
  output: EMPTY_TERMINAL_BUFFER_STATE.output,
  status: "closed",
  error: null,
  hasRunningSubprocess: false,
  updatedAt: null,
  replayStartVersion: 0,
  replayCompleteVersion: 0,
  version: 0,
  lifecycleVersion: 0,
});

// Retention needs enough headroom for the renderer to consume several adjacent
// 64 KB server batches without falling behind and resetting its scrollback.
export const DEFAULT_MAX_TERMINAL_BUFFER_BYTES = 512 * 1024;
const DEFAULT_TERMINAL_CHUNK_BYTES = 16 * 1024;
const MAX_TERMINAL_OUTPUT_CHUNKS = 1_024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Keep attach replay size and live client retention as separate budgets. */
export function terminalOutputRetentionBytes(replayBytes?: number): number {
  return Math.max(DEFAULT_MAX_TERMINAL_BUFFER_BYTES, replayBytes ?? 0);
}

function trimBufferToBytes(buffer: string, maxBufferBytes: number): string {
  if (maxBufferBytes <= 0) {
    return "";
  }

  const encoded = textEncoder.encode(buffer);
  if (encoded.byteLength <= maxBufferBytes) {
    return buffer;
  }

  let start = encoded.byteLength - maxBufferBytes;
  while (start < encoded.length) {
    const byte = encoded[start];
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) {
      break;
    }
    start += 1;
  }

  return textDecoder.decode(encoded.subarray(start));
}

function splitOutputChunks(
  data: string,
  firstChunkId: number,
  delivery: "replay" | "live",
  maxChunkBytes = DEFAULT_TERMINAL_CHUNK_BYTES,
): {
  readonly chunks: ReadonlyArray<TerminalOutputChunk>;
  readonly latestChunkId: number;
  readonly byteLength: number;
} {
  const split = splitStringByUtf8Bytes(data, maxChunkBytes);
  let byteLength = 0;
  const chunks = split.map((chunk, index) => {
    byteLength += chunk.byteLength;
    return {
      id: firstChunkId + index,
      data: chunk.data,
      byteLength: chunk.byteLength,
      delivery,
    };
  });

  return {
    chunks,
    latestChunkId: firstChunkId + chunks.length - 1,
    byteLength,
  };
}

/**
 * Merge adjacent same-delivery chunks up to the standard chunk size so a long
 * run of tiny interactive writes cannot exhaust the chunk budget and force a
 * full renderer reset. Merged chunks take the id of their last constituent.
 */
function compactRetainedChunks(chunks: ReadonlyArray<TerminalOutputChunk>): {
  readonly chunks: ReadonlyArray<TerminalOutputChunk>;
  readonly compactedThroughId: number | null;
} {
  const compacted: TerminalOutputChunk[] = [];
  let compactedThroughId: number | null = null;
  for (const chunk of chunks) {
    const previous = compacted.at(-1);
    if (
      previous !== undefined &&
      previous.delivery === chunk.delivery &&
      previous.byteLength + chunk.byteLength <= DEFAULT_TERMINAL_CHUNK_BYTES
    ) {
      compacted[compacted.length - 1] = {
        id: chunk.id,
        data: `${previous.data}${chunk.data}`,
        byteLength: previous.byteLength + chunk.byteLength,
        delivery: chunk.delivery,
      };
      compactedThroughId = chunk.id;
    } else {
      compacted.push(chunk);
    }
  }
  return { chunks: compacted, compactedThroughId };
}

function appendOutput(
  current: TerminalOutputState,
  data: string,
  maxBufferBytes: number,
  delivery: "replay" | "live",
): TerminalOutputState {
  const appended = splitOutputChunks(
    data,
    current.latestChunkId + 1,
    delivery,
    Math.min(DEFAULT_TERMINAL_CHUNK_BYTES, Math.max(1, maxBufferBytes)),
  );
  if (appended.chunks.length === 0) return current;
  if (maxBufferBytes <= 0) {
    return {
      chunks: [],
      retainedBytes: 0,
      resetVersion: current.resetVersion + 1,
      latestChunkId: appended.latestChunkId,
      compactedThroughId: appended.latestChunkId,
    };
  }

  const chunks = [...current.chunks, ...appended.chunks];
  let retainedBytes = current.retainedBytes + appended.byteLength;
  let firstRetainedIndex = 0;
  while (retainedBytes > maxBufferBytes && firstRetainedIndex < chunks.length) {
    retainedBytes -= chunks[firstRetainedIndex]?.byteLength ?? 0;
    firstRetainedIndex += 1;
  }

  let retainedChunks = firstRetainedIndex === 0 ? chunks : chunks.slice(firstRetainedIndex);
  if (retainedChunks.length === 0) {
    return {
      chunks: [],
      retainedBytes: 0,
      resetVersion: current.resetVersion + 1,
      latestChunkId: appended.latestChunkId,
      compactedThroughId: appended.latestChunkId,
    };
  }
  let compactedThroughId = current.compactedThroughId;
  if (retainedChunks.length > MAX_TERMINAL_OUTPUT_CHUNKS) {
    // Compact only chunks that predate this append: an up-to-date cursor sits
    // on the previous latest chunk id, and merged spans keep the id of their
    // last constituent, so that boundary survives compaction.
    const retainedOldCount = Math.max(0, retainedChunks.length - appended.chunks.length);
    const compacted = compactRetainedChunks(retainedChunks.slice(0, retainedOldCount));
    const compactedChunks = [...compacted.chunks, ...retainedChunks.slice(retainedOldCount)];
    if (compactedChunks.length > MAX_TERMINAL_OUTPUT_CHUNKS) {
      return resetOutput(
        {
          ...current,
          latestChunkId: appended.latestChunkId,
        },
        retainedChunks.map((chunk) => chunk.data).join(""),
        maxBufferBytes,
      );
    }
    retainedChunks = compactedChunks;
    if (compacted.compactedThroughId !== null) {
      compactedThroughId = Math.max(compactedThroughId, compacted.compactedThroughId);
    }
  }

  return {
    chunks: retainedChunks,
    retainedBytes,
    resetVersion: current.resetVersion,
    latestChunkId: appended.latestChunkId,
    compactedThroughId,
  };
}

function resetOutput(
  current: TerminalOutputState,
  data: string,
  maxBufferBytes: number,
): TerminalOutputState {
  const retained = trimBufferToBytes(data, maxBufferBytes);
  const reset = splitOutputChunks(
    retained,
    current.latestChunkId + 1,
    "replay",
    Math.min(DEFAULT_TERMINAL_CHUNK_BYTES, Math.max(1, maxBufferBytes)),
  );
  return {
    chunks: reset.chunks,
    retainedBytes: reset.byteLength,
    resetVersion: current.resetVersion + 1,
    latestChunkId: reset.latestChunkId,
    compactedThroughId: current.latestChunkId,
  };
}

export function terminalOutputText(output: TerminalOutputState): string {
  return output.chunks.map((chunk) => chunk.data).join("");
}

export function readTerminalOutputUpdate(
  output: TerminalOutputState,
  cursor: TerminalOutputCursor,
): TerminalOutputUpdate {
  const nextCursor = {
    resetVersion: output.resetVersion,
    lastChunkId: output.latestChunkId,
  };
  const firstChunk = output.chunks[0];
  if (
    cursor.resetVersion !== output.resetVersion ||
    // The cursor may sit inside a merged chunk, so it no longer names a
    // provable boundary in the retained stream.
    cursor.lastChunkId < output.compactedThroughId ||
    (firstChunk !== undefined && firstChunk.id > cursor.lastChunkId + 1)
  ) {
    return { type: "reset", data: terminalOutputText(output), cursor: nextCursor };
  }

  const appended = output.chunks.filter((chunk) => chunk.id > cursor.lastChunkId);
  if (appended.length === 0) {
    return { type: "none", cursor: nextCursor };
  }
  const segments: Array<{ data: string; delivery: "replay" | "live" }> = [];
  for (const chunk of appended) {
    const previous = segments.at(-1);
    if (previous?.delivery === chunk.delivery) {
      previous.data += chunk.data;
    } else {
      segments.push({ data: chunk.data, delivery: chunk.delivery });
    }
  }
  return {
    type: "append",
    segments,
    cursor: nextCursor,
  };
}

export function terminalBufferStateFromSnapshot(
  snapshot: TerminalSessionSnapshot,
  maxBufferBytes: number,
  current: TerminalBufferState = EMPTY_TERMINAL_BUFFER_STATE,
): TerminalBufferState {
  return {
    output: resetOutput(current.output, snapshot.history, maxBufferBytes),
    status: snapshot.status,
    error: null,
    updatedAt: snapshot.updatedAt,
    replayStartVersion: current.replayStartVersion,
    replayCompleteVersion: current.replayCompleteVersion,
    version: current.version + 1,
    lifecycleVersion: current.lifecycleVersion,
  };
}

function latestTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

export function combineTerminalSessionState(
  summary: TerminalSummary | null,
  buffer: TerminalBufferState,
): TerminalSessionState {
  return {
    summary,
    output: buffer.output,
    status: buffer.version > 0 ? buffer.status : (summary?.status ?? buffer.status),
    error: buffer.error,
    hasRunningSubprocess: summary?.hasRunningSubprocess ?? false,
    updatedAt: latestTimestamp(summary?.updatedAt ?? null, buffer.updatedAt),
    replayStartVersion: buffer.replayStartVersion,
    replayCompleteVersion: buffer.replayCompleteVersion,
    version: buffer.version,
    lifecycleVersion: buffer.lifecycleVersion,
  };
}

export function applyTerminalAttachStreamEvent(
  current: TerminalBufferState,
  event: TerminalAttachStreamEvent,
  maxBufferBytes = DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
): TerminalBufferState {
  switch (event.type) {
    case "replay-start":
      return {
        ...current,
        replayStartVersion: current.replayStartVersion + 1,
      };
    case "snapshot":
      return {
        ...terminalBufferStateFromSnapshot(event.snapshot, maxBufferBytes, current),
        lifecycleVersion:
          current.version === 0 ? current.lifecycleVersion : current.lifecycleVersion + 1,
      };
    case "restarted":
      return {
        ...terminalBufferStateFromSnapshot(event.snapshot, maxBufferBytes, current),
        lifecycleVersion: current.lifecycleVersion + 1,
      };
    case "output":
      return {
        ...current,
        output: appendOutput(
          current.output,
          event.data,
          maxBufferBytes,
          current.replayStartVersion > current.replayCompleteVersion ? "replay" : "live",
        ),
        status: current.status === "closed" ? "running" : current.status,
        error: null,
        version: current.version + 1,
      };
    case "replay-complete":
      // Latch to the start counter instead of incrementing. Replay markers can
      // be lost (slow-consumer resync) or repeated (transport hand-off re-runs
      // the attach), and one completion always closes every open replay.
      return {
        ...current,
        replayCompleteVersion: current.replayStartVersion,
        version: current.version + 1,
      };
    case "cleared":
      return {
        ...current,
        output: resetOutput(current.output, "", maxBufferBytes),
        error: null,
        version: current.version + 1,
      };
    case "exited":
      return {
        ...current,
        status: "exited",
        error: null,
        version: current.version + 1,
      };
    case "closed":
      return {
        ...current,
        status: "closed",
        error: null,
        version: current.version + 1,
      };
    case "error":
      return {
        ...current,
        status: "error",
        error: event.message,
        version: current.version + 1,
      };
    case "activity":
      return current;
  }
}

export function applyTerminalMetadataStreamEvent(
  current: ReadonlyArray<TerminalSummary>,
  event: TerminalMetadataStreamEvent,
): ReadonlyArray<TerminalSummary> {
  if (event.type === "snapshot") {
    return event.terminals;
  }
  if (event.type === "remove") {
    return current.filter(
      (terminal) =>
        terminal.threadId !== event.threadId || terminal.terminalId !== event.terminalId,
    );
  }
  const next = current.filter(
    (terminal) =>
      terminal.threadId !== event.terminal.threadId ||
      terminal.terminalId !== event.terminal.terminalId,
  );
  return [...next, event.terminal];
}
