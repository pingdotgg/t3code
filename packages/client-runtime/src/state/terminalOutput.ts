export interface TerminalOutputChunk {
  readonly id: number;
  readonly data: string;
  readonly byteLength: number;
}

export interface TerminalOutputState {
  readonly generation: number;
  readonly chunks: ReadonlyArray<TerminalOutputChunk>;
  readonly retainedBytes: number;
  readonly resetVersion: number;
  readonly latestChunkId: number;
  /**
   * A cursor below this id cannot safely append after chunks are merged or trimmed.
   */
  readonly compactedThroughId: number;
}

export interface TerminalOutputCursor {
  readonly generation: number;
  readonly resetVersion: number;
  readonly lastChunkId: number;
}

/** Forces the first `readTerminalOutputUpdate` to resynchronize from a reset. */
export const INITIAL_TERMINAL_OUTPUT_CURSOR = Object.freeze<TerminalOutputCursor>({
  generation: -1,
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
      readonly data: string;
    };

export const DEFAULT_MAX_TERMINAL_BUFFER_BYTES = 512 * 1024;
const DEFAULT_TERMINAL_CHUNK_BYTES = 16 * 1024;
const MAX_TERMINAL_OUTPUT_CHUNKS = 1_024;
const textEncoder = new TextEncoder();
// A BOM at a retained chunk boundary is terminal data, not an encoding marker.
const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

export const EMPTY_TERMINAL_OUTPUT_STATE = Object.freeze<TerminalOutputState>({
  generation: 0,
  chunks: Object.freeze([]),
  retainedBytes: 0,
  resetVersion: 0,
  latestChunkId: 0,
  compactedThroughId: 0,
});

interface Utf8Chunk {
  readonly data: string;
  readonly byteLength: number;
}

/**
 * Split a string into chunks of at most `maxBytes` UTF-8 bytes without cutting
 * a code point in half. The retained-output budget always supplies a positive
 * size. Only new output is encoded on live updates.
 *
 * A chunk that fits whole is returned as the original string, so the common
 * small-write path pays one encode and no decode.
 */
function splitStringByUtf8Bytes(data: string, maxBytes: number): ReadonlyArray<Utf8Chunk> {
  if (data.length === 0) return [];

  const encoded = textEncoder.encode(data);
  if (encoded.byteLength <= maxBytes) {
    return [{ data, byteLength: encoded.byteLength }];
  }

  const chunks: Utf8Chunk[] = [];
  let offset = 0;
  while (offset < encoded.byteLength) {
    let end = Math.min(offset + maxBytes, encoded.byteLength);
    while (end < encoded.byteLength && ((encoded[end] ?? 0) & 0xc0) === 0x80) {
      end -= 1;
    }
    // A degenerate budget smaller than one code point still has to advance:
    // include the whole code point rather than looping forever.
    if (end === offset) {
      end = Math.min(offset + maxBytes, encoded.byteLength);
      while (end < encoded.byteLength && ((encoded[end] ?? 0) & 0xc0) === 0x80) {
        end += 1;
      }
    }
    const bytes = encoded.subarray(offset, end);
    chunks.push({ data: textDecoder.decode(bytes), byteLength: bytes.byteLength });
    offset = end;
  }

  return chunks;
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
    };
  });

  return {
    chunks,
    latestChunkId: firstChunkId + chunks.length - 1,
    byteLength,
  };
}

/**
 * Merge adjacent chunks up to the standard chunk size so a long
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
      previous.byteLength + chunk.byteLength <= DEFAULT_TERMINAL_CHUNK_BYTES
    ) {
      compacted[compacted.length - 1] = {
        id: chunk.id,
        data: `${previous.data}${chunk.data}`,
        byteLength: previous.byteLength + chunk.byteLength,
      };
      compactedThroughId = chunk.id;
    } else {
      compacted.push(chunk);
    }
  }
  return { chunks: compacted, compactedThroughId };
}

// Scan only the removed prefix instead of encoding retained output again.
function trimOutputChunkStart(
  chunk: TerminalOutputChunk,
  bytesToDrop: number,
): TerminalOutputChunk {
  let offset = 0;
  let droppedBytes = 0;
  while (droppedBytes < bytesToDrop && offset < chunk.data.length) {
    const codepoint = chunk.data.codePointAt(offset)!;
    droppedBytes += codepoint <= 0x7f ? 1 : codepoint <= 0x7ff ? 2 : codepoint <= 0xffff ? 3 : 4;
    offset += codepoint <= 0xffff ? 1 : 2;
  }
  return {
    ...chunk,
    data: chunk.data.slice(offset),
    byteLength: chunk.byteLength - droppedBytes,
  };
}

function appendOutput(
  current: TerminalOutputState,
  data: string,
  maxBufferBytes: number,
): TerminalOutputState {
  const appended = splitOutputChunks(
    data,
    current.latestChunkId + 1,
    Math.min(DEFAULT_TERMINAL_CHUNK_BYTES, Math.max(1, maxBufferBytes)),
  );
  if (appended.chunks.length === 0) return current;
  if (maxBufferBytes <= 0) {
    return {
      generation: current.generation,
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
  let compactedThroughId = current.compactedThroughId;
  while (retainedBytes > maxBufferBytes && firstRetainedIndex < chunks.length) {
    const first = chunks[firstRetainedIndex]!;
    const bytesToDrop = retainedBytes - maxBufferBytes;
    if (bytesToDrop < first.byteLength) {
      const trimmed = trimOutputChunkStart(first, bytesToDrop);
      retainedBytes -= first.byteLength - trimmed.byteLength;
      compactedThroughId = Math.max(compactedThroughId, first.id);
      if (trimmed.byteLength > 0) {
        chunks[firstRetainedIndex] = trimmed;
      } else {
        firstRetainedIndex += 1;
      }
      break;
    }
    retainedBytes -= first.byteLength;
    firstRetainedIndex += 1;
  }

  let retainedChunks = firstRetainedIndex === 0 ? chunks : chunks.slice(firstRetainedIndex);
  if (retainedChunks.length === 0) {
    return {
      generation: current.generation,
      chunks: [],
      retainedBytes: 0,
      resetVersion: current.resetVersion + 1,
      latestChunkId: appended.latestChunkId,
      compactedThroughId: appended.latestChunkId,
    };
  }
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
    generation: current.generation,
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
    Math.min(DEFAULT_TERMINAL_CHUNK_BYTES, Math.max(1, maxBufferBytes)),
  );
  return {
    generation: current.generation,
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
    generation: output.generation,
    resetVersion: output.resetVersion,
    lastChunkId: output.latestChunkId,
  };
  const firstChunk = output.chunks[0];
  if (
    cursor.generation !== output.generation ||
    cursor.resetVersion !== output.resetVersion ||
    // The cursor may precede a trimmed chunk or sit inside merged data.
    cursor.lastChunkId < output.compactedThroughId ||
    (firstChunk !== undefined && firstChunk.id > cursor.lastChunkId + 1)
  ) {
    return { type: "reset", data: terminalOutputText(output), cursor: nextCursor };
  }

  const appended = output.chunks.filter((chunk) => chunk.id > cursor.lastChunkId);
  if (appended.length === 0) {
    return { type: "none", cursor: nextCursor };
  }
  return {
    type: "append",
    data: appended.map((chunk) => chunk.data).join(""),
    cursor: nextCursor,
  };
}

export { appendOutput, resetOutput };
