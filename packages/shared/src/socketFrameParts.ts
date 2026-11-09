import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";
import { inflateSync, strFromU8 } from "fflate";

// Old clients omit this; old servers ignore it.
export const SOCKET_FRAME_PARTS_QUERY_PARAM = "frameParts";
// The client can inflate frames the server deflated. The server only does so
// when the socket negotiated no permessage-deflate, as iOS sockets never do.
export const SOCKET_FRAME_DEFLATE_QUERY_PARAM = "frameDeflate";
// Smaller frames gain little from a deflate without a shared window.
const SOCKET_FRAME_DEFLATE_MIN_CHARS = 1024;
const BINARY_PART_MORE = 1;
const BINARY_PART_LAST = 0;

// WebSocket messages arrive whole. At 4,000 bytes/s each part takes about
// 12 seconds, leaving margin before the client's 15-second liveness timeout.
const SOCKET_FRAME_PART_BYTES = 48 * 1024;

// No JSON message starts with a record separator. It marks every part but the last.
const PART_PREFIX = "\u001e";

// The RPC client only counts frames that decode to messages as liveness, and
// ignores pongs, so each held-back part reads to it as one.
const PART_RECEIVED_FRAME = '{"_tag":"Pong"}';

/** Splits on the UTF-8 size the frame has on the wire, never inside a surrogate pair. */
export function splitSocketFrame(
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

/** Raw DEFLATE bytes as binary parts, each led by a byte that says whether more follow. */
export function splitDeflatedSocketFrame(
  deflated: Uint8Array,
  partBytes = SOCKET_FRAME_PART_BYTES,
): Arr.NonEmptyReadonlyArray<Uint8Array> {
  const size = partBytes - 1;
  const parts: Array<Uint8Array> = [];
  for (let start = 0; start === 0 || start < deflated.length; start += size) {
    const body = deflated.subarray(start, start + size);
    const part = new Uint8Array(body.length + 1);
    part[0] = start + size < deflated.length ? BINARY_PART_MORE : BINARY_PART_LAST;
    part.set(body, 1);
    parts.push(part);
  }
  return parts as unknown as Arr.NonEmptyReadonlyArray<Uint8Array>;
}

/**
 * Server side: sends string frames longer than one part as consecutive parts.
 * With `deflate` (raw DEFLATE), larger string frames go out as binary parts.
 */
export function splitLargeSocketFrames(
  socket: Socket.Socket,
  deflate?: (frame: string) => Uint8Array,
): Socket.Socket {
  const split = (chunk: string | Uint8Array): Arr.NonEmptyReadonlyArray<string | Uint8Array> =>
    typeof chunk !== "string"
      ? [chunk]
      : deflate !== undefined && chunk.length >= SOCKET_FRAME_DEFLATE_MIN_CHARS
        ? splitDeflatedSocketFrame(deflate(chunk))
        : splitSocketFrame(chunk);
  return Socket.make({
    reader: socket.reader,
    writer: Effect.map(socket.writer, (writer) => ({
      write: (chunk) =>
        typeof chunk === "string" ? writer.writeAll(split(chunk)) : writer.write(chunk),
      writeAll: (chunks) => writer.writeAll(Arr.flatMap(chunks, split)),
    })),
  });
}

/** Client side: joins parts back into whole frames, inflating deflated ones. */
export function joinSocketFrameParts(socket: Socket.Socket): Socket.Socket {
  return Socket.make({
    reader: Effect.map(socket.reader, (reader) => {
      let pending = "";
      let pendingBinary: Array<Uint8Array> = [];
      const joinBinary = (part: Uint8Array) => {
        pendingBinary.push(part.subarray(1));
        if (part[0] === BINARY_PART_MORE) return PART_RECEIVED_FRAME;
        const deflated = new Uint8Array(
          pendingBinary.reduce((size, body) => size + body.length, 0),
        );
        let offset = 0;
        for (const body of pendingBinary) {
          deflated.set(body, offset);
          offset += body.length;
        }
        pendingBinary = [];
        return strFromU8(inflateSync(deflated));
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
