import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";

// Old clients omit this; old servers ignore it.
export const SOCKET_FRAME_PARTS_QUERY_PARAM = "frameParts";

// WebSocket messages arrive whole. At 4,000 bytes/s each part takes about
// 12 seconds, leaving margin before the client's 15-second liveness timeout.
export const SOCKET_FRAME_PART_BYTES = 48 * 1024;

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
