import { describe, expect, it } from "@effect/vitest";
import { joinSocketFrameParts, socketFrameSplitterFor } from "@t3tools/shared/socketFrameParts";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";
import * as NodeZlib from "node:zlib";

import { deflatedJson, wantsDeflatedFrames } from "./wsDeflatedFrames.ts";

/** Text that deflate cannot shrink much: 6 random bits per character. */
const noise = (length: number) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let state = 0x9e3779b9;
  let text = "";
  for (let index = 0; index < length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    text += alphabet[(state >>> 0) % 64];
  }
  return text;
};

/** Writes one frame through a socket wrapper and returns what reaches the wire. */
const wireFrames = (wrap: (socket: Socket.Socket) => Socket.Socket, frame: string | Uint8Array) =>
  Effect.gen(function* () {
    const written: Array<string | Uint8Array> = [];
    const record = (chunk: string | Uint8Array | Socket.CloseEvent) => {
      if (typeof chunk === "string" || chunk instanceof Uint8Array) written.push(chunk);
    };
    const socket = wrap(
      Socket.make({
        reader: Effect.die("unused"),
        writer: Effect.succeed({
          write: (chunk) => Effect.sync(() => record(chunk)),
          writeAll: (chunks) => Effect.sync(() => chunks.forEach(record)),
        }),
      }),
    );
    yield* Effect.scoped(Effect.flatMap(socket.writer, (writer) => writer.write(frame)));
    return written;
  });

/** Reads wire frames through the client's joiner and returns what its decoder receives. */
const joinedFrames = (frames: ReadonlyArray<string | Uint8Array>) =>
  Effect.gen(function* () {
    const [first, ...rest] = frames;
    const socket = joinSocketFrameParts(
      Socket.make({
        reader: Effect.succeed({
          pull: Effect.succeed([first!, ...rest] as const),
          upgrade: () => Effect.void,
        }),
        writer: Effect.die("unused"),
      }),
    );
    return yield* Effect.scoped(Effect.flatMap(socket.reader, (reader) => reader.pull));
  });

describe("deflated RPC frames", () => {
  it.effect.each([
    { frameParts: "1", splitsBinary: false },
    { frameParts: "2", splitsBinary: true },
  ])(
    "frameParts=$frameParts splits deflated frames: $splitsBinary, and the client reads them",
    ({ frameParts, splitsBinary }) =>
      Effect.gen(function* () {
        const response = { _tag: "Chunk", requestId: "1", values: [noise(160 * 1024)] };
        const encoded = deflatedJson.makeUnsafe().encode(response);
        expect(encoded).toBeInstanceOf(Uint8Array);
        const split = socketFrameSplitterFor(new URL(`ws://h/ws?frameParts=${frameParts}`));
        const wire = yield* wireFrames(split!, encoded as Uint8Array);
        if (splitsBinary) {
          expect(wire.length).toBeGreaterThan(1);
          for (const frame of wire) expect(frame.length).toBeLessThanOrEqual(48 * 1024);
        } else {
          // A client that asked for frameParts=1 cannot join binary parts.
          expect(wire).toEqual([encoded]);
        }
        const received = yield* joinedFrames(wire);
        const whole = received.at(-1);
        expect(whole).toBeInstanceOf(Uint8Array);
        expect(JSON.parse(NodeZlib.inflateRawSync(whole as Uint8Array).toString())).toEqual(
          response,
        );
      }),
  );

  it("sends large frames as raw deflate and small ones as text", () => {
    const parser = deflatedJson.makeUnsafe();
    const large = { _tag: "Chunk", requestId: "1", values: ["x".repeat(4096)] };
    const encoded = parser.encode(large);
    expect(encoded).toBeInstanceOf(Uint8Array);
    expect((encoded as Uint8Array).length).toBeLessThan(200);
    expect(JSON.parse(NodeZlib.inflateRawSync(encoded as Uint8Array).toString())).toEqual(large);
    expect(parser.encode({ _tag: "Pong" })).toBe('{"_tag":"Pong"}');
    expect(parser.decode('{"_tag":"Ping"}')).toEqual([{ _tag: "Ping" }]);
  });

  it.each([
    ["ws://h/ws?deflatedFrames=1", {}, true],
    ["ws://h/ws", {}, false],
    [
      "ws://h/ws?deflatedFrames=1",
      { "sec-websocket-extensions": "permessage-deflate; client_max_window_bits" },
      false,
    ],
  ])("%s %o -> %s", (url, headers, expected) => {
    expect(wantsDeflatedFrames(new URL(url), headers)).toBe(expected);
  });
});
