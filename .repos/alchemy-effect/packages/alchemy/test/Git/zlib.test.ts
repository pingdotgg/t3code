/**
 * `inflateEntry` (src/Git/Protocol/Zlib.ts): the exact-span inflate the pack
 * parser runs per entry. Pack entries are back-to-back zlib streams with no
 * length prefix, so the consumed-input count is as important as the output.
 */
import { inflateEntry } from "@/Git/Protocol/Zlib.ts";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import zlib from "node:zlib";

const content = (n: number, seed: number) => {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed * 7) & 0xff;
  return out;
};

describe("inflateEntry", () => {
  test("returns the content and the exact compressed span, ignoring trailing bytes", async () => {
    const a = content(5000, 1);
    const b = content(300, 2);
    const za = new Uint8Array(zlib.deflateSync(a));
    const zb = new Uint8Array(zlib.deflateSync(b));
    const pack = new Uint8Array(za.length + zb.length + 3);
    pack.set(za, 0);
    pack.set(zb, za.length);
    pack.set([9, 9, 9], za.length + zb.length);
    const first = await Effect.runPromise(
      inflateEntry(pack, 0, { expectedSize: a.length }),
    );
    expect(first.bytesConsumed).toBe(za.length);
    expect(Array.from(first.content)).toEqual(Array.from(a));
    const second = await Effect.runPromise(
      inflateEntry(pack, first.bytesConsumed, { expectedSize: b.length }),
    );
    expect(second.bytesConsumed).toBe(zb.length);
    expect(Array.from(second.content)).toEqual(Array.from(b));
  });

  test("a wrong expectedSize is not trusted from the fast path: the result is still exact", async () => {
    const a = content(2000, 3);
    const za = new Uint8Array(zlib.deflateSync(a));
    const buf = new Uint8Array(za.length + 5);
    buf.set(za, 0);
    // The fast paths refuse (output != expectedSize) and the streaming path
    // answers; either way the caller gets the real span and content.
    const out = await Effect.runPromise(
      inflateEntry(buf, 0, { expectedSize: a.length + 1 }),
    );
    expect(out.bytesConsumed).toBe(za.length);
    expect(out.content.length).toBe(a.length);
  });

  test("an incompressible 1 MiB entry round-trips (multi-chunk output)", async () => {
    const big = new Uint8Array(1 << 20);
    crypto.getRandomValues(big.subarray(0, 65536));
    for (let at = 65536; at < big.length; at += 65536)
      big.copyWithin(at, 0, 65536);
    for (let i = 0; i < big.length; i += 4099) big[i] ^= 0x5a;
    const z = new Uint8Array(zlib.deflateSync(big));
    const buf = new Uint8Array(z.length + 2);
    buf.set(z, 0);
    const out = await Effect.runPromise(
      inflateEntry(buf, 0, { expectedSize: big.length }),
    );
    expect(out.bytesConsumed).toBe(z.length);
    expect(out.content.length).toBe(big.length);
    expect(out.content[4099]).toBe(big[4099]);
  });

  test("corrupt input fails with a typed ZlibError", async () => {
    const junk = new Uint8Array([0x78, 0x9c, 1, 2, 3, 4, 5, 6, 7, 8]);
    const result = await Effect.runPromise(
      Effect.result(inflateEntry(junk, 0, { expectedSize: 10 })),
    );
    expect(result._tag).toBe("Failure");
  });
});
