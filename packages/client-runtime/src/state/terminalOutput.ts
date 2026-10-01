export interface TerminalOutputChunk {
  /** UTF-16 string offset within this generation and reset. */
  readonly startOffset: number;
  readonly data: string;
  readonly byteLength: number;
}

export interface TerminalOutputState {
  readonly generation: number;
  readonly chunks: ReadonlyArray<TerminalOutputChunk>;
  readonly retainedBytes: number;
  readonly resetVersion: number;
  readonly nextOffset: number;
}

export interface TerminalOutputCursor {
  readonly generation: number;
  readonly resetVersion: number;
  readonly offset: number;
}

/** Forces the first `readTerminalOutputUpdate` to resynchronize from a reset. */
export const INITIAL_TERMINAL_OUTPUT_CURSOR = Object.freeze<TerminalOutputCursor>({
  generation: -1,
  resetVersion: -1,
  offset: 0,
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
  nextOffset: 0,
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
  firstOffset: number,
  maxChunkBytes = DEFAULT_TERMINAL_CHUNK_BYTES,
): {
  readonly chunks: ReadonlyArray<TerminalOutputChunk>;
  readonly nextOffset: number;
  readonly byteLength: number;
} {
  const split = splitStringByUtf8Bytes(data, maxChunkBytes);
  let byteLength = 0;
  let nextOffset = firstOffset;
  const chunks = split.map((chunk) => {
    byteLength += chunk.byteLength;
    const startOffset = nextOffset;
    nextOffset += chunk.data.length;
    return {
      startOffset,
      data: chunk.data,
      byteLength: chunk.byteLength,
    };
  });

  return {
    chunks,
    nextOffset,
    byteLength,
  };
}

/**
 * Merge adjacent chunks without changing their string positions. A reader can
 * still append the unread suffix when its cursor falls inside a merged chunk.
 */
function compactRetainedChunks(chunks: ReadonlyArray<TerminalOutputChunk>) {
  const compacted: TerminalOutputChunk[] = [];
  for (const chunk of chunks) {
    const previous = compacted.at(-1);
    if (
      previous !== undefined &&
      previous.startOffset + previous.data.length === chunk.startOffset &&
      previous.byteLength + chunk.byteLength <= DEFAULT_TERMINAL_CHUNK_BYTES
    ) {
      compacted[compacted.length - 1] = {
        startOffset: previous.startOffset,
        data: `${previous.data}${chunk.data}`,
        byteLength: previous.byteLength + chunk.byteLength,
      };
    } else {
      compacted.push(chunk);
    }
  }
  return compacted;
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
    startOffset: chunk.startOffset + offset,
    data: chunk.data.slice(offset),
    byteLength: chunk.byteLength - droppedBytes,
  };
}

function appendOutput(
  current: TerminalOutputState,
  data: string,
  maxBufferBytes: number,
): TerminalOutputState {
  if (data.length === 0) return current;
  if (maxBufferBytes <= 0) {
    return {
      generation: current.generation,
      chunks: [],
      retainedBytes: 0,
      resetVersion: current.resetVersion + 1,
      nextOffset: current.nextOffset + data.length,
    };
  }
  const appended = splitOutputChunks(
    data,
    current.nextOffset,
    Math.min(DEFAULT_TERMINAL_CHUNK_BYTES, Math.max(1, maxBufferBytes)),
  );

  const chunks = [...current.chunks, ...appended.chunks];
  let retainedBytes = current.retainedBytes + appended.byteLength;
  let firstRetainedIndex = 0;
  while (retainedBytes > maxBufferBytes && firstRetainedIndex < chunks.length) {
    const first = chunks[firstRetainedIndex]!;
    const bytesToDrop = retainedBytes - maxBufferBytes;
    if (bytesToDrop < first.byteLength) {
      const trimmed = trimOutputChunkStart(first, bytesToDrop);
      retainedBytes -= first.byteLength - trimmed.byteLength;
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
  if (retainedChunks.length > MAX_TERMINAL_OUTPUT_CHUNKS) {
    retainedChunks = compactRetainedChunks(retainedChunks);
    const excessChunks = retainedChunks.length - MAX_TERMINAL_OUTPUT_CHUNKS;
    if (excessChunks > 0) {
      for (const chunk of retainedChunks.slice(0, excessChunks)) {
        retainedBytes -= chunk.byteLength;
      }
      retainedChunks = retainedChunks.slice(excessChunks);
    }
  }

  return {
    generation: current.generation,
    chunks: retainedChunks,
    retainedBytes,
    resetVersion: current.resetVersion,
    nextOffset: appended.nextOffset,
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
    0,
    Math.min(DEFAULT_TERMINAL_CHUNK_BYTES, Math.max(1, maxBufferBytes)),
  );
  return {
    generation: current.generation,
    chunks: reset.chunks,
    retainedBytes: reset.byteLength,
    resetVersion: current.resetVersion + 1,
    nextOffset: reset.nextOffset,
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
    offset: output.nextOffset,
  };
  const firstChunk = output.chunks[0];
  if (
    cursor.generation !== output.generation ||
    cursor.resetVersion !== output.resetVersion ||
    cursor.offset < (firstChunk?.startOffset ?? output.nextOffset)
  ) {
    return { type: "reset", data: terminalOutputText(output), cursor: nextCursor };
  }

  const appended = output.chunks.filter(
    (chunk) => chunk.startOffset + chunk.data.length > cursor.offset,
  );
  if (appended.length === 0) {
    return { type: "none", cursor: nextCursor };
  }
  return {
    type: "append",
    data: appended
      .map((chunk) => chunk.data.slice(Math.max(0, cursor.offset - chunk.startOffset)))
      .join(""),
    cursor: nextCursor,
  };
}

export { appendOutput, resetOutput };
