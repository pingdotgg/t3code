/**
 * Sideband framing (src/Git/Protocol/Sideband.ts): the single-copy frame, the
 * whole-chunk framer the native pump uses, and the deterministic re-chunker
 * that writes a bundle's pre-framed twin — whose output must be a pure
 * function of the input bytes, however the input is chunked.
 */
import {
  SIDEBAND_DATA_MAX,
  sidebandFrame,
  sidebandFrameAll,
  sidebandFramedLength,
  sidebandRechunk,
} from "@/Git/Protocol/Sideband.ts";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const bytes = (n: number, seed = 1) => {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
};

/** Parses band-1 frames back into data; asserts every frame is well-formed. */
const deframe = (framed: Uint8Array) => {
  const pieces: Array<Uint8Array> = [];
  let pos = 0;
  while (pos < framed.length) {
    const len = Number.parseInt(
      new TextDecoder().decode(framed.subarray(pos, pos + 4)),
      16,
    );
    expect(len).toBeGreaterThan(5);
    expect(len).toBeLessThanOrEqual(SIDEBAND_DATA_MAX + 5);
    expect(framed[pos + 4]).toBe(1);
    pieces.push(framed.subarray(pos + 5, pos + len));
    pos += len;
  }
  expect(pos).toBe(framed.length);
  const total = pieces.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of pieces) {
    out.set(p, at);
    at += p.length;
  }
  return { data: out, frames: pieces.map((p) => p.length) };
};

describe("sidebandFrame / sidebandFrameAll", () => {
  test("sidebandFrame is header + data in one buffer", () => {
    const data = bytes(10);
    const frame = sidebandFrame(1, data);
    expect(frame.length).toBe(15);
    expect(new TextDecoder().decode(frame.subarray(0, 4))).toBe("000f");
    expect(frame[4]).toBe(1);
    expect(Array.from(frame.subarray(5))).toEqual(Array.from(data));
  });

  test("sidebandFrameAll cuts exactly at SIDEBAND_DATA_MAX and round-trips", () => {
    const data = bytes(SIDEBAND_DATA_MAX * 2 + 123);
    const framed = sidebandFrameAll(1, data);
    expect(framed.length).toBe(sidebandFramedLength(data.length));
    const back = deframe(framed);
    expect(back.frames).toEqual([SIDEBAND_DATA_MAX, SIDEBAND_DATA_MAX, 123]);
    expect(Array.from(back.data)).toEqual(Array.from(data));
  });

  test("sidebandFrameAll of an empty chunk is empty", () => {
    expect(sidebandFrameAll(1, new Uint8Array(0)).length).toBe(0);
  });
});

describe("sidebandRechunk", () => {
  const run = (chunks: ReadonlyArray<Uint8Array>) =>
    Effect.runPromise(
      Stream.fromIterable(chunks).pipe(
        sidebandRechunk(1),
        Stream.runCollect,
        Effect.map((c) => {
          const parts = Array.from(c);
          const total = parts.reduce((n, p) => n + p.length, 0);
          const out = new Uint8Array(total);
          let at = 0;
          for (const p of parts) {
            out.set(p, at);
            at += p.length;
          }
          return out;
        }),
      ),
    );

  test("output is independent of input chunking", async () => {
    const data = bytes(SIDEBAND_DATA_MAX * 3 + 4567, 7);
    const whole = await run([data]);
    const tiny = await run(
      Array.from({ length: Math.ceil(data.length / 1000) }, (_, i) =>
        data.subarray(i * 1000, Math.min((i + 1) * 1000, data.length)),
      ),
    );
    const uneven = await run([
      data.subarray(0, 3),
      data.subarray(3, SIDEBAND_DATA_MAX + 1),
      data.subarray(SIDEBAND_DATA_MAX + 1),
    ]);
    expect(whole.length).toBe(sidebandFramedLength(data.length));
    expect(Array.from(tiny)).toEqual(Array.from(whole));
    expect(Array.from(uneven)).toEqual(Array.from(whole));
    const back = deframe(whole);
    expect(back.frames).toEqual([
      SIDEBAND_DATA_MAX,
      SIDEBAND_DATA_MAX,
      SIDEBAND_DATA_MAX,
      4567,
    ]);
    expect(Array.from(back.data)).toEqual(Array.from(data));
  });

  test("an exact multiple of the frame size has no short tail; empty input frames nothing", async () => {
    const data = bytes(SIDEBAND_DATA_MAX * 2, 3);
    const framed = await run([data.subarray(0, 100), data.subarray(100)]);
    expect(deframe(framed).frames).toEqual([
      SIDEBAND_DATA_MAX,
      SIDEBAND_DATA_MAX,
    ]);
    expect((await run([])).length).toBe(0);
    expect((await run([new Uint8Array(0)])).length).toBe(0);
  });
});
