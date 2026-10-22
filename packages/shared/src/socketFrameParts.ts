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
export const SOCKET_FRAME_PART_LENGTH = 64 * 1024;

// No JSON message starts with a record separator. It marks every part but the last.
const PART_PREFIX = "\u001e";

// The RPC client only counts frames that decode to messages as liveness, and
// ignores pongs, so each held-back part reads to it as one.
const PART_RECEIVED_FRAME = '{"_tag":"Pong"}';

export function splitSocketFrame(
  frame: string,
  partLength = SOCKET_FRAME_PART_LENGTH,
): Arr.NonEmptyReadonlyArray<string> {
  if (frame.length <= partLength) return [frame];
  const parts: Array<string> = [];
  let start = 0;
  while (frame.length - start > partLength) {
    let end = start + partLength;
    // A lone surrogate half does not survive the UTF-8 encoding of a text frame.
    const last = frame.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    parts.push(PART_PREFIX + frame.slice(start, end));
    start = end;
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
        typeof chunk === "string" && chunk.length > SOCKET_FRAME_PART_LENGTH
          ? writer.writeAll(splitSocketFrame(chunk))
          : writer.write(chunk),
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
