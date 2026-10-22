import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";

/**
 * A client sets this on its WebSocket URL to accept large messages in parts.
 * Servers that predate it ignore it and keep sending whole messages.
 */
export const SOCKET_FRAME_PARTS_QUERY_PARAM = "frameParts";

// The RPC client's ping is answered behind whatever the server is already
// sending, and a WebSocket message only arrives once all of it has. On a slow
// link a multi-megabyte config snapshot outlasts the ping timeout, so the
// client drops a healthy server and asks for the same snapshot again. Parts
// this size keep a frame arriving within the timeout down to a few KB/s.
export const SOCKET_FRAME_PART_BYTES = 64 * 1024;

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

/** Server side: sends string frames longer than one part as consecutive parts. */
export function splitLargeSocketFrames(socket: Socket.Socket): Socket.Socket {
  const split = (chunk: string | Uint8Array): Arr.NonEmptyReadonlyArray<string | Uint8Array> =>
    typeof chunk === "string" ? splitSocketFrame(chunk) : [chunk];
  return Socket.make({
    reader: socket.reader,
    writer: Effect.map(socket.writer, (writer) => ({
      write: (chunk) =>
        typeof chunk === "string" ? writer.writeAll(splitSocketFrame(chunk)) : writer.write(chunk),
      writeAll: (chunks) => writer.writeAll(Arr.flatMap(chunks, split)),
    })),
  });
}

/** Client side: joins parts back into whole frames. */
export function joinSocketFrameParts(socket: Socket.Socket): Socket.Socket {
  return Socket.make({
    reader: Effect.map(socket.reader, (reader) => {
      let pending = "";
      const join = (frame: string | Uint8Array) => {
        if (typeof frame !== "string") return frame;
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
