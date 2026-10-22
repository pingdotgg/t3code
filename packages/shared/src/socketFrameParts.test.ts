import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Socket from "effect/socket/Socket";

import {
  joinSocketFrameParts,
  SOCKET_FRAME_PART_LENGTH,
  splitLargeSocketFrames,
} from "./socketFrameParts.ts";

const unusedUpgrade = () => Effect.void;

function recordingSocket(sent: Array<string | Uint8Array>) {
  return Socket.make({
    reader: Effect.succeed({ pull: Effect.never, upgrade: unusedUpgrade }),
    writer: Effect.succeed({
      write: (chunk) =>
        Effect.sync(() => {
          if (!Socket.isCloseEvent(chunk)) sent.push(chunk);
        }),
      writeAll: (chunks) => Effect.sync(() => void sent.push(...chunks)),
    }),
  });
}

function replayingSocket(batches: ReadonlyArray<readonly [string, ...Array<string>]>) {
  let next = 0;
  return Socket.make({
    reader: Effect.succeed({
      pull: Effect.suspend(() =>
        next < batches.length ? Effect.succeed(batches[next++]!) : Effect.never,
      ),
      upgrade: unusedUpgrade,
    }),
    writer: Effect.succeed({ write: () => Effect.void, writeAll: () => Effect.void }),
  });
}

it.effect("a large message reaches the client whole, with a frame for every part on the way", () =>
  Effect.gen(function* () {
    // Emoji put surrogate pairs across part boundaries.
    const message = JSON.stringify({
      _tag: "Chunk",
      values: ["😀".repeat(SOCKET_FRAME_PART_LENGTH), "x".repeat(SOCKET_FRAME_PART_LENGTH)],
    });
    const sent: Array<string | Uint8Array> = [];
    const serverWriter = yield* splitLargeSocketFrames(recordingSocket(sent)).writer;
    yield* serverWriter.write(message);
    yield* serverWriter.write('{"_tag":"Pong"}');

    const parts = sent.filter((frame) => typeof frame === "string");
    assert.isAbove(parts.length, 3);
    assert.isTrue(parts.every((part) => part.length <= SOCKET_FRAME_PART_LENGTH + 1));
    assert.isTrue(
      parts.every((part) => new TextDecoder().decode(new TextEncoder().encode(part)) === part),
    );

    const [first, ...rest] = parts;
    const reader = yield* joinSocketFrameParts(replayingSocket([[first!, ...rest]])).reader;
    const received = yield* reader.pull;

    assert.strictEqual(received.length, parts.length);
    const held = received.slice(0, -2);
    assert.isTrue(held.every((frame) => JSON.parse(frame as string)._tag === "Pong"));
    assert.strictEqual(received.at(-2), message);
    assert.strictEqual(received.at(-1), '{"_tag":"Pong"}');
  }).pipe(Effect.scoped),
);

it.effect("a server that predates parts still reaches the client whole", () =>
  Effect.gen(function* () {
    const message = JSON.stringify({
      _tag: "Chunk",
      values: ["x".repeat(3 * SOCKET_FRAME_PART_LENGTH)],
    });
    const reader = yield* joinSocketFrameParts(replayingSocket([[message]])).reader;
    assert.deepStrictEqual(yield* reader.pull, [message]);
  }).pipe(Effect.scoped),
);
