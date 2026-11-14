import {
  retainedTerminalHistory,
  TERMINAL_SEQUENCE_GROUND,
  terminalSequenceEnd,
  terminalSequenceStateAfter,
} from "@t3tools/contracts";

export interface TerminalOutputChunk {
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
  // The terminal parser's state at the first retained code unit. Trimming can cut a control
  // sequence, and a replay has to skip the rest of it instead of printing it.
  readonly sequenceState: number;
  /** Chunks before this offset are replayed to emulators but are no longer displayed text. */
  readonly textStartOffset: number;
}

export interface TerminalOutputCursor {
  readonly generation: number;
  readonly resetVersion: number;
  readonly offset: number;
  // The cut control sequence still open at `offset`, which the reader's terminal never entered.
  readonly sequenceState: number;
}

export const INITIAL_TERMINAL_OUTPUT_CURSOR = Object.freeze<TerminalOutputCursor>({
  generation: -1,
  resetVersion: -1,
  offset: 0,
  sequenceState: TERMINAL_SEQUENCE_GROUND,
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
  sequenceState: TERMINAL_SEQUENCE_GROUND,
  textStartOffset: 0,
});

interface Utf8Chunk {
  readonly data: string;
  readonly byteLength: number;
}

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
      sequenceState: TERMINAL_SEQUENCE_GROUND,
      textStartOffset: current.textStartOffset,
    };
  }
  const appended = splitOutputChunks(
    data,
    current.nextOffset,
    Math.min(DEFAULT_TERMINAL_CHUNK_BYTES, Math.max(1, maxBufferBytes)),
  );

  const chunks = [...current.chunks, ...appended.chunks];
  let retainedBytes = current.retainedBytes + appended.byteLength;
  let sequenceState = current.sequenceState;
  let firstRetainedIndex = 0;
  while (retainedBytes > maxBufferBytes && firstRetainedIndex < chunks.length) {
    const first = chunks[firstRetainedIndex]!;
    const bytesToDrop = retainedBytes - maxBufferBytes;
    if (bytesToDrop < first.byteLength) {
      const trimmed = trimOutputChunkStart(first, bytesToDrop);
      sequenceState = terminalSequenceStateAfter(
        sequenceState,
        first.data,
        0,
        first.data.length - trimmed.data.length,
      );
      retainedBytes -= first.byteLength - trimmed.byteLength;
      if (trimmed.byteLength > 0) {
        chunks[firstRetainedIndex] = trimmed;
      } else {
        firstRetainedIndex += 1;
      }
      break;
    }
    sequenceState = terminalSequenceStateAfter(sequenceState, first.data);
    retainedBytes -= first.byteLength;
    firstRetainedIndex += 1;
  }

  let retainedChunks = firstRetainedIndex === 0 ? chunks : chunks.slice(firstRetainedIndex);
  if (retainedChunks.length > MAX_TERMINAL_OUTPUT_CHUNKS) {
    retainedChunks = compactRetainedChunks(retainedChunks);
    const excessChunks = retainedChunks.length - MAX_TERMINAL_OUTPUT_CHUNKS;
    if (excessChunks > 0) {
      for (const chunk of retainedChunks.slice(0, excessChunks)) {
        sequenceState = terminalSequenceStateAfter(sequenceState, chunk.data);
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
    sequenceState,
    textStartOffset: current.textStartOffset,
  };
}

function resetOutput(
  current: TerminalOutputState,
  data: string,
  maxBufferBytes: number,
): TerminalOutputState {
  const retained = retainedTerminalHistory(data, maxBufferBytes);
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
    sequenceState: TERMINAL_SEQUENCE_GROUND,
    textStartOffset: 0,
  };
}

// Erases the screen and scrollback only. A full emulator reset would drop the
// screen and input modes the still-running program negotiated.
const CLEAR_TERMINAL_TEXT = "\u001b[H\u001b[2J\u001b[3J";

/** Earlier output stays retained so a replay from the start restores those modes. */
function clearOutput(current: TerminalOutputState, maxBufferBytes: number): TerminalOutputState {
  // The erase rides over the budget: trimming here would evict the output that set those modes.
  const cleared = appendOutput(
    current,
    CLEAR_TERMINAL_TEXT,
    maxBufferBytes <= 0
      ? maxBufferBytes
      : Math.max(maxBufferBytes, current.retainedBytes + CLEAR_TERMINAL_TEXT.length),
  );
  return { ...cleared, textStartOffset: cleared.nextOffset };
}

/** Everything a fresh emulator replays: retained output from outside any control sequence. */
export function terminalOutputReplay(output: TerminalOutputState): string {
  const text = output.chunks.map((chunk) => chunk.data).join("");
  return text.slice(terminalSequenceEnd(output.sequenceState, text));
}

/** The output as plain text, for surfaces that do not interpret escape sequences. */
export function terminalOutputText(output: TerminalOutputState): string {
  const text = output.chunks.map((chunk) => chunk.data).join("");
  const firstOffset = output.chunks[0]?.startOffset ?? output.nextOffset;
  return text.slice(
    Math.max(terminalSequenceEnd(output.sequenceState, text), output.textStartOffset - firstOffset),
  );
}

export function readTerminalOutputUpdate(
  output: TerminalOutputState,
  cursor: TerminalOutputCursor,
): TerminalOutputUpdate {
  const position = {
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
    const text = output.chunks.map((chunk) => chunk.data).join("");
    const start = terminalSequenceEnd(output.sequenceState, text);
    return {
      type: "reset",
      data: text.slice(start),
      cursor: {
        ...position,
        sequenceState: terminalSequenceStateAfter(output.sequenceState, text, 0, start),
      },
    };
  }

  // Appends and compaction preserve offset order, so unread chunks form a suffix.
  let firstUnread = output.chunks.length;
  while (firstUnread > 0) {
    const chunk = output.chunks[firstUnread - 1]!;
    if (!(chunk.startOffset + chunk.data.length > cursor.offset)) break;
    firstUnread -= 1;
  }
  const text = output.chunks
    .slice(firstUnread)
    .map((chunk) => chunk.data.slice(Math.max(0, cursor.offset - chunk.startOffset)))
    .join("");
  const start = terminalSequenceEnd(cursor.sequenceState, text);
  const nextCursor = {
    ...position,
    sequenceState: terminalSequenceStateAfter(cursor.sequenceState, text, 0, start),
  };
  if (start === text.length) {
    return { type: "none", cursor: nextCursor };
  }
  return { type: "append", data: text.slice(start), cursor: nextCursor };
}

export { appendOutput, clearOutput, resetOutput };
