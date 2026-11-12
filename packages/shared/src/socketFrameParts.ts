import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";

// Old clients omit this; old servers ignore it, or split only text frames whatever its value.
export const SOCKET_FRAME_PARTS_QUERY_PARAM = "frameParts";
// "1" asks for text parts only; "2" also asks for binary (deflated) parts.
export const SOCKET_FRAME_PARTS_VERSION = "2";

// WebSocket messages arrive whole. At 4,000 bytes/s each part takes about
// 12 seconds, leaving margin before the client's 15-second liveness timeout.
const SOCKET_FRAME_PART_BYTES = 48 * 1024;

// No JSON message starts with a record separator. It marks every part but the last.
const PART_PREFIX = "\u001e";
// Binary frames are raw deflate, whose first byte can never be 0x1e or 0x1f: both declare
// the reserved block type 0b11. Every binary part carries one, as its data is arbitrary.
const BINARY_PART_PREFIX = 0x1e;
const BINARY_LAST_PART_PREFIX = 0x1f;

// The RPC client only counts frames that decode to messages as liveness, and
// ignores pongs, so each held-back part reads to it as one.
const PART_RECEIVED_FRAME = '{"_tag":"Pong"}';

/** Splits on the UTF-8 size the frame has on the wire, never inside a surrogate pair. */
function splitSocketFrame(
  frame: string,
  partBytes = SOCKET_FRAME_PART_BYTES,
): Arr.NonEmptyReadonlyArray<string> {
  // UTF-8 spends at most 3 bytes on a UTF-16 code unit.
  if (frame.length * 3 <= partBytes) return [frame];
  const parts: Array<string> = [];
  let start = 0;
  let bytes = PART_PREFIX.length;
  for (let index = 0; index < frame.length;) {
    const code = frame.charCodeAt(index);
    const pair = code >= 0xd800 && code <= 0xdbff && index + 1 < frame.length;
    const size = pair ? 4 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    if (bytes + size > partBytes) {
      parts.push(PART_PREFIX + frame.slice(start, index));
      start = index;
      bytes = PART_PREFIX.length;
    }
    bytes += size;
    index += pair ? 2 : 1;
  }
  return Arr.append(parts, frame.slice(start));
}

function splitBinarySocketFrame(
  frame: Uint8Array,
  partBytes = SOCKET_FRAME_PART_BYTES,
): Arr.NonEmptyReadonlyArray<Uint8Array> {
  if (frame.length <= partBytes) return [frame];
  const parts: Array<Uint8Array> = [];
  let start = 0;
  for (; frame.length - start >= partBytes; start += partBytes - 1) {
    const part = new Uint8Array(partBytes);
    part[0] = BINARY_PART_PREFIX;
    part.set(frame.subarray(start, start + partBytes - 1), 1);
    parts.push(part);
  }
  const last = new Uint8Array(frame.length - start + 1);
  last[0] = BINARY_LAST_PART_PREFIX;
  last.set(frame.subarray(start), 1);
  return Arr.append(parts, last);
}

/** Server side: sends frames longer than one part as consecutive parts. */
function splitLargeSocketFrames(socket: Socket.Socket, binary: boolean): Socket.Socket {
  const split = (chunk: string | Uint8Array): Arr.NonEmptyReadonlyArray<string | Uint8Array> =>
    typeof chunk === "string"
      ? splitSocketFrame(chunk)
      : binary
        ? splitBinarySocketFrame(chunk)
        : [chunk];
  return Socket.make({
    reader: socket.reader,
    writer: Effect.map(socket.writer, (writer) => ({
      write: (chunk) =>
        typeof chunk === "string" || chunk instanceof Uint8Array
          ? writer.writeAll(split(chunk))
          : writer.write(chunk),
      writeAll: (chunks) => writer.writeAll(Arr.flatMap(chunks, split)),
    })),
  });
}

/** The server's splitter for the frame parts a client's socket URL asks for, if any. */
export function socketFrameSplitterFor(
  url: URL,
): ((socket: Socket.Socket) => Socket.Socket) | undefined {
  const version = url.searchParams.get(SOCKET_FRAME_PARTS_QUERY_PARAM);
  if (version === null) return undefined;
  const binary = Number(version) >= 2;
  return (socket) => splitLargeSocketFrames(socket, binary);
}

/** Client side: joins parts back into whole frames. */
export function joinSocketFrameParts(socket: Socket.Socket): Socket.Socket {
  return Socket.make({
    reader: Effect.map(socket.reader, (reader) => {
      let pending = "";
      let pendingBinary: Array<Uint8Array> = [];
      const joinBinary = (frame: Uint8Array) => {
        if (frame[0] === BINARY_PART_PREFIX) {
          pendingBinary.push(frame.subarray(1));
          return PART_RECEIVED_FRAME;
        }
        if (frame[0] !== BINARY_LAST_PART_PREFIX) return frame;
        pendingBinary.push(frame.subarray(1));
        const whole = new Uint8Array(pendingBinary.reduce((size, part) => size + part.length, 0));
        let offset = 0;
        for (const part of pendingBinary) {
          whole.set(part, offset);
          offset += part.length;
        }
        pendingBinary = [];
        return whole;
      };
      const join = (frame: string | Uint8Array) => {
        if (typeof frame !== "string") return joinBinary(frame);
        if (frame.startsWith(PART_PREFIX)) {
          pending += frame.slice(PART_PREFIX.length);
          return PART_RECEIVED_FRAME;
        }
        if (pending === "") return frame;
        const whole = pending + frame;
        pending = "";
        return whole;
      };
      return {
        upgrade: reader.upgrade,
        pull: Effect.map(reader.pull, Arr.map(join)),
      };
    }),
    writer: socket.writer,
  });
}
