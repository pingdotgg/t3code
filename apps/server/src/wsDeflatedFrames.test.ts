import { describe, expect, it } from "@effect/vitest";
import { joinSocketFrameParts, socketFrameSplitterFor } from "@t3tools/shared/socketFrameParts";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";
import * as NodeZlib from "node:zlib";

import { deflatedJson, wantsDeflatedFrames } from "./wsDeflatedFrames.ts";

/** Text that deflate cannot shrink much: 6 random bits per character. */
const noise = (length: number, seed = 0x9e3779b9) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let state = seed;
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
    { frameParts: "1", seed: 0x9e3779b9, splitsBinary: false },
    { frameParts: "2", seed: 0x9e3779b9, splitsBinary: true },
    // Seed 175 makes the stream's final part begin with 0x1e, the continuation marker.
    { frameParts: "2", seed: 175, splitsBinary: true },
  ])(
    "frameParts=$frameParts splits deflated frames: $splitsBinary, and the client reads them (seed $seed)",
    ({ frameParts, seed, splitsBinary }) =>
      Effect.gen(function* () {
        const response = { _tag: "Chunk", requestId: "1", values: [noise(160 * 1024, seed)] };
        const parser = deflatedJson.makeUnsafe();
        const encoded = parser.encode(response);
        expect(encoded).toBeInstanceOf(Uint8Array);
        const next = parser.encode({ _tag: "Exit", requestId: "2" });
        if (typeof next !== "string") return expect.fail("a small frame stays text");
        const split = socketFrameSplitterFor(new URL(`ws://h/ws?frameParts=${frameParts}`));
        const wire = yield* wireFrames(split!, encoded as Uint8Array);
        if (splitsBinary) {
          expect(wire.length).toBeGreaterThan(1);
          for (const frame of wire) expect(frame.length).toBeLessThanOrEqual(48 * 1024);
        } else {
          // A client that asked for frameParts=1 cannot join binary parts.
          expect(wire).toEqual([encoded]);
        }
        const received = yield* joinedFrames([...wire, next]);
        expect(received.at(-1)).toBe(next);
        const whole = received.at(-2);
        expect(whole).toBeInstanceOf(Uint8Array);
        expect(JSON.parse(NodeZlib.inflateRawSync(whole as Uint8Array).toString())).toEqual(
          response,
        );
      }),
  );

  it.effect("joins binary parts whatever byte the data at each part boundary starts with", () =>
    Effect.gen(function* () {
      const split = socketFrameSplitterFor(new URL("ws://h/ws?frameParts=2"));
      const part = 48 * 1024;
      const lengths = [part, part + 1, 2 * (part - 1), 2 * (part - 1) + 1, 3 * part + 5];
      for (const fill of [0x1e, 0x1f]) {
        for (const length of lengths) {
          const frame = new Uint8Array(length).fill(fill);
          frame[0] = 0;
          const wire = yield* wireFrames(split!, frame);
          for (const sent of wire) expect(sent.length).toBeLessThanOrEqual(part);
          const received = yield* joinedFrames([...wire, '{"_tag":"Pong"}']);
          expect(received.at(-2)).toEqual(frame);
          expect(received.at(-1)).toBe('{"_tag":"Pong"}');
        }
      }
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
