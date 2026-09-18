/**
 * The streaming pack source (src/Git/Store/StreamingSource.ts): reads
 * block until bytes arrive, in-slab reads are views, retention drops
 * consumed slabs and falls back to the spilled reader, and the feeder is
 * throttled by backpressure.
 */
import { bufferRandomAccess } from "@/Git/Protocol/PackParser.ts";
import { StoreError } from "@/Git/Protocol/Store.ts";
import { makeStreamingSource } from "@/Git/Store/StreamingSource.ts";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

const bytes = (n: number, seed = 1) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
};

describe("StreamingSource", () => {
  test("a read past what has arrived waits; in-slab reads are views", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const feeder = makeStreamingSource({ slabBytes: 1024 });
        const data = bytes(3000);
        // Reader starts first and blocks.
        const pending = yield* Effect.forkChild(feeder.source.read(1000, 500));
        expect(feeder.source.readSync!(0, 10)).toBeUndefined();
        yield* feeder.push(data.subarray(0, 700));
        yield* feeder.push(data.subarray(700, 1600));
        const got = yield* Fiber.join(pending);
        expect(Array.from(got)).toEqual(Array.from(data.subarray(1000, 1500)));
        // Inside one slab: a view of the slab's buffer.
        const view = feeder.source.readSync!(1024, 100)!;
        expect(view.byteOffset).toBe(0);
        expect(Array.from(view)).toEqual(Array.from(data.subarray(1024, 1124)));
        // Across a slab edge, readSync declines; read assembles.
        expect(feeder.source.readSync!(1000, 100)).toBeUndefined();
        const across = yield* feeder.source.read(1000, 100);
        expect(Array.from(across)).toEqual(
          Array.from(data.subarray(1000, 1100)),
        );
        yield* feeder.push(data.subarray(1600));
        feeder.end();
        expect(yield* feeder.source.awaitEnd).toBe(3000);
        // Short read at the end.
        expect((yield* feeder.source.read(2990, 100)).length).toBe(10);
        expect(feeder.source.readSync!(2990, 100)!.length).toBe(10);
      }),
    );
  });

  test("retention drops consumed slabs; evicted reads go to the fallback after end", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const feeder = makeStreamingSource({
          slabBytes: 1000,
          retainBytes: 2500,
          backpressureBytes: 1 << 20,
        });
        const data = bytes(6000, 5);
        for (let at = 0; at < data.length; at += 1500)
          yield* feeder.push(data.subarray(at, at + 1500));
        // Nothing consumed: everything retained.
        expect(feeder.source.readSync!(0, 10)).toBeDefined();
        feeder.source.release(4000);
        // Now the oldest slabs are gone.
        expect(feeder.source.readSync!(0, 10)).toBeUndefined();
        expect(feeder.source.readSync!(4500, 10)).toBeDefined();
        // A read below the window waits for the fallback + end.
        const pending = yield* Effect.forkChild(feeder.source.read(100, 50));
        feeder.setFallback(bufferRandomAccess(data));
        feeder.end();
        const got = yield* Fiber.join(pending);
        expect(Array.from(got)).toEqual(Array.from(data.subarray(100, 150)));
      }),
    );
  });

  test("backpressure: push waits until the parser releases", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const feeder = makeStreamingSource({
          slabBytes: 1000,
          backpressureBytes: 1500,
        });
        yield* feeder.push(bytes(1000));
        let pushed = false;
        const blocked = yield* Effect.forkChild(
          feeder.push(bytes(1000)).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                pushed = true;
              }),
            ),
          ),
        );
        yield* Effect.sleep("20 millis");
        expect(pushed).toBe(false); // still waiting on backpressure
        feeder.source.release(1500);
        yield* Fiber.join(blocked);
        expect(pushed).toBe(true);
      }),
    );
  });

  test("fail wakes every waiter with the error", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const feeder = makeStreamingSource();
        const pending = yield* Effect.forkChild(
          Effect.result(feeder.source.read(0, 10)),
        );
        feeder.fail(new StoreError({ reason: "boom" }));
        const r = yield* Fiber.join(pending);
        expect(r._tag).toBe("Failure");
      }),
    );
  });
});
