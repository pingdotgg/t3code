import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { STILL_FRAME_DELAY, repeatStillFrame } from "./mjpegStillFrame.ts";

const part = (body: string) =>
  Buffer.from(
    `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${body.length}\r\n\r\n${body}\r\n`,
  );

const viewer = Effect.gen(function* () {
  const upstream = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  let received = "";
  const fiber = yield* repeatStillFrame(Stream.fromQueue(upstream)).pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        received += Buffer.from(chunk).toString();
      }),
    ),
    Effect.forkChild,
  );
  const send = (...chunks: ReadonlyArray<Uint8Array>) =>
    Effect.gen(function* () {
      for (const chunk of chunks) yield* Queue.offer(upstream, chunk);
      yield* Effect.yieldNow;
    });
  const finish = Effect.gen(function* () {
    yield* Queue.end(upstream);
    yield* Fiber.join(fiber);
    return received;
  });
  return { send, finish };
});

describe("repeatStillFrame", () => {
  it.effect("re-sends only the newest complete frame once when the screen stays still", () =>
    Effect.gen(function* () {
      const { send, finish } = yield* viewer;
      yield* send(part("first"));
      yield* TestClock.adjust(STILL_FRAME_DELAY);
      yield* send(Buffer.concat([part("second"), part("third")]));
      yield* TestClock.adjust(STILL_FRAME_DELAY);
      yield* TestClock.adjust(STILL_FRAME_DELAY);
      expect(yield* finish).toBe(
        `${part("first")}${part("first")}${part("second")}${part("third")}${part("third")}`,
      );
    }),
  );

  it.effect("never repeats into a frame that is still arriving", () =>
    Effect.gen(function* () {
      const { send, finish } = yield* viewer;
      const second = part("second");
      // The pause lands inside the second part's headers.
      yield* send(part("first"), second.subarray(0, 20));
      yield* TestClock.adjust(STILL_FRAME_DELAY);
      yield* send(second.subarray(20));
      yield* TestClock.adjust(STILL_FRAME_DELAY);
      expect(yield* finish).toBe(`${part("first")}${second}${second}`);
    }),
  );

  it.effect("recognizes a frame whose final CRLF arrives in a later chunk", () =>
    Effect.gen(function* () {
      const { send, finish } = yield* viewer;
      const first = part("first");
      yield* send(first.subarray(0, -1), first.subarray(-1));
      yield* TestClock.adjust(STILL_FRAME_DELAY);
      expect(yield* finish).toBe(`${first}${first}`);
    }),
  );

  it.effect("passes through bodies without the hub's part framing", () =>
    Effect.gen(function* () {
      const { send, finish } = yield* viewer;
      const unframed = Buffer.from("--frame\r\nContent-Type: image/jpeg\r\n\r\nbody\r\n");
      yield* send(unframed);
      yield* TestClock.adjust(STILL_FRAME_DELAY);
      yield* send(part("later"));
      yield* TestClock.adjust(STILL_FRAME_DELAY);
      expect(yield* finish).toBe(`${unframed}${part("later")}`);
    }),
  );
});
