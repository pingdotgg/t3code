/**
 * The partial-pack scanner (src/Git/Protocol/PartialScan.ts): the hashing
 * Worker's unit of work. Entries are settled inside a buffer that starts
 * at an entry boundary; the tail is carried; deltas whose base lies in an
 * earlier buffer are reported unresolved.
 */
import {
  hashObject,
  encodeTypeSize,
  makeSha1,
  type Oid,
} from "@/Git/Protocol/ObjectCodec.ts";
import {
  findBoundary,
  hashBounds,
  scanBounds,
  scanPart,
} from "@/Git/Protocol/PartialScan.ts";
import { packHeader } from "@/Git/Protocol/PackWriter.ts";
import * as Zlib from "@/Git/Protocol/Zlib.ts";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { concat } from "./harness/pack.ts";

const buildPack = (n: number) =>
  Effect.gen(function* () {
    const pieces: Array<Uint8Array> = [packHeader(n)];
    const oids: Array<Oid> = [];
    for (let i = 0; i < n; i++) {
      const size = 100 + ((i * 977) % 4900);
      const content = new Uint8Array(size);
      crypto.getRandomValues(content);
      content[0] = i & 0xff;
      oids.push(yield* hashObject(3, content));
      pieces.push(encodeTypeSize(3, size), yield* Zlib.deflate(content));
    }
    const body = concat(pieces);
    const sha = makeSha1();
    sha.update(body);
    return { pack: concat([body, sha.digest()]), oids, count: n };
  });

/** Drives the scanner the way the pipeline does: parts + carry. */
const scanInParts = (
  pack: Uint8Array,
  count: number,
  partSizes: (i: number) => number,
) =>
  Effect.gen(function* () {
    // Parts run to the END of the pack (trailer included) so the last entry
    // is followed by bytes, per the scanner's contract.
    const end = pack.length;
    let consumedTo = 12; // after the pack header
    let remaining = count;
    let cursor = 12;
    const all: Array<Oid> = [];
    const unresolved: Array<{ offset: number }> = [];
    let i = 0;
    let carry: Uint8Array = new Uint8Array(0);
    while (cursor < end) {
      const n = Math.min(partSizes(i++), end - cursor);
      const payload = concat([carry, pack.subarray(cursor, cursor + n)]);
      const base = consumedTo;
      const result = yield* scanPart(payload, {
        base,
        remaining,
        maxObjectSize: 64 << 20,
      });
      for (const e of result.entries) all.push(e.oid);
      for (const u of result.unresolved) unresolved.push(u);
      remaining -= result.count;
      cursor += n;
      carry = payload.subarray(result.consumedTo - base);
      consumedTo = result.consumedTo;
    }
    expect(remaining).toBe(0);
    expect(carry.length).toBe(20); // exactly the trailer is left over
    return { all, unresolved };
  });

describe("scanPart", () => {
  test("a pack split at arbitrary points, with carry, yields every entry exactly once", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { pack, oids, count } = yield* buildPack(400);
        for (const sizes of [
          () => 1000,
          (i: number) => 100 + ((i * 7919) % 5000),
          () => 1 << 20,
        ]) {
          const { all, unresolved } = yield* scanInParts(pack, count, sizes);
          expect(all.length).toBe(count);
          expect(new Set(all)).toEqual(new Set(oids));
          expect(unresolved).toEqual([]);
        }
      }),
    );
  });

  test("the ofs-delta fixture: whole-buffer scan resolves every delta; small parts report cross-part bases unresolved", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = path.join(import.meta.dirname, "fixtures", "packs");
        const pack = yield* fs.readFile(path.join(dir, "ofs-delta.pack"));
        const manifest = JSON.parse(
          yield* fs.readFileString(path.join(dir, "manifest.json")),
        ) as {
          packs: Record<string, { oids: ReadonlyArray<string> }>;
        };
        const expected = new Set(manifest.packs["ofs-delta"]!.oids);
        const count = new DataView(pack.buffer, pack.byteOffset).getUint32(8);
        const whole = yield* scanPart(pack.subarray(12), {
          base: 12,
          remaining: count,
          maxObjectSize: 64 << 20,
        });
        expect(whole.unresolved).toEqual([]);
        expect(whole.count).toBe(count);
        expect(new Set(whole.entries.map((e) => e.oid))).toEqual(expected);
        expect(whole.entries.some((e) => e.zdata !== undefined)).toBe(true); // delta-resolved ones carry fresh zdata
        // Tiny parts: bases fall into earlier buffers.
        const { all, unresolved } = yield* scanInParts(pack, count, () => 64);
        expect(unresolved.length).toBeGreaterThan(0);
        expect(all.length + unresolved.length).toBe(count);
        for (const oid of all) expect(expected.has(oid)).toBe(true);
      }).pipe(Effect.provide(BunServices.layer)),
    );
  });
});

describe("an entry ending exactly at the buffer edge is not consumed", () => {
  test("the scanner carries it until bytes follow", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { pack, count } = yield* buildPack(3);
        const first = yield* scanPart(pack.subarray(12), {
          base: 12,
          remaining: count,
          maxObjectSize: 1 << 20,
        });
        expect(first.count).toBe(3);
        const cut = first.entries[1]!.dataOffset + first.entries[1]!.span;
        const partial = yield* scanPart(pack.subarray(12, cut), {
          base: 12,
          remaining: count,
          maxObjectSize: 1 << 20,
        });
        expect(partial.count).toBe(1);
        expect(partial.consumedTo).toBeLessThan(cut);
        expect(partial.consumedTo).toBe(
          first.entries[0]!.dataOffset + first.entries[0]!.span,
        );
      }),
    );
  });
});

describe("scanBounds + hashBounds (DESIGN §22.8)", () => {
  test("boundary scan then known-span hashing equals the single-pass scan on a synthetic pack", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { pack, oids, count } = yield* buildPack(300);
        const buf = pack.subarray(12);
        const bounds = yield* scanBounds(buf, {
          base: 12,
          remaining: count,
          maxObjectSize: 64 << 20,
        });
        expect(bounds.entries.length).toBe(count);
        expect(bounds.consumedTo).toBe(pack.length - 20);
        const hashed = yield* hashBounds(buf, bounds.entries, {
          base: 12,
          maxObjectSize: 64 << 20,
        });
        expect(hashed.entries.map((e) => e.oid)).toEqual(oids);
        expect(hashed.unresolved).toEqual([]);
        const single = yield* scanPart(buf, {
          base: 12,
          remaining: count,
          maxObjectSize: 64 << 20,
        });
        expect(
          hashed.entries.map((e) => [e.oid, e.offset, e.dataOffset, e.span]),
        ).toEqual(
          single.entries.map((e) => [e.oid, e.offset, e.dataOffset, e.span]),
        );
      }),
    );
  });

  test("the ofs-delta fixture: bounds carry base offsets; hashing resolves every in-buffer delta", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = path.join(import.meta.dirname, "fixtures", "packs");
        const pack = yield* fs.readFile(path.join(dir, "ofs-delta.pack"));
        const manifest = JSON.parse(
          yield* fs.readFileString(path.join(dir, "manifest.json")),
        ) as {
          packs: Record<string, { oids: ReadonlyArray<string> }>;
        };
        const expected = new Set(manifest.packs["ofs-delta"]!.oids);
        const count = new DataView(pack.buffer, pack.byteOffset).getUint32(8);
        const buf = pack.subarray(12);
        const bounds = yield* scanBounds(buf, {
          base: 12,
          remaining: count,
          maxObjectSize: 64 << 20,
        });
        expect(bounds.entries.length).toBe(count);
        expect(
          bounds.entries.some(
            (b) => b.type === 6 && b.baseOffset !== undefined,
          ),
        ).toBe(true);
        const hashed = yield* hashBounds(buf, bounds.entries, {
          base: 12,
          maxObjectSize: 64 << 20,
        });
        expect(hashed.unresolved).toEqual([]);
        expect(new Set(hashed.entries.map((e) => e.oid))).toEqual(expected);
        // Hashing only the second half: bases in the first half are unresolved.
        const half = bounds.entries.slice(Math.floor(count / 2));
        const partial = yield* hashBounds(buf, half, {
          base: 12,
          maxObjectSize: 64 << 20,
        });
        expect(partial.entries.length + partial.unresolved.length).toBe(
          half.length,
        );
      }).pipe(Effect.provide(BunServices.layer)),
    );
  });
});

describe("findBoundary (DESIGN §22.9)", () => {
  test("a boundary past the first MiB is found: the search covers the whole chunk", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // One 1.5 MiB blob followed by small ones: a chunk starting inside
        // the big blob has its first boundary ~1.5 MiB in.
        const big = new Uint8Array(1_500_000);
        crypto.getRandomValues(big);
        const pieces: Array<Uint8Array> = [
          packHeader(4),
          encodeTypeSize(3, big.length),
          yield* Zlib.deflate(big),
        ];
        for (let i = 0; i < 3; i++) {
          const c = new Uint8Array(500);
          crypto.getRandomValues(c);
          pieces.push(encodeTypeSize(3, c.length), yield* Zlib.deflate(c));
        }
        const body = concat(pieces);
        const sha = makeSha1();
        sha.update(body);
        const pack = concat([body, sha.digest()]);
        const bigEnd = 12 + pieces[1]!.length + pieces[2]!.length;
        const chunk = pack.subarray(100);
        expect(findBoundary(chunk, { maxObjectSize: 1 << 24 })).toBe(
          bigEnd - 100,
        );
        expect(
          findBoundary(chunk, { maxObjectSize: 1 << 24, maxSearch: 1 << 20 }),
        ).toBeUndefined();
      }),
    );
  });
  test("from arbitrary offsets in a synthetic pack, the first boundary found is a true entry start", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { pack, count } = yield* buildPack(200);
        const truth = yield* scanBounds(pack.subarray(12), {
          base: 12,
          remaining: count,
          maxObjectSize: 1 << 20,
        });
        const starts = new Set(truth.entries.map((b) => b.offset));
        let seed = 3;
        for (let i = 0; i < 60; i++) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          const at = 12 + (seed % (pack.length - 40_000));
          const chunk = pack.subarray(at, at + 30_000);
          const found = findBoundary(chunk, { maxObjectSize: 1 << 20 });
          expect(found).toBeDefined();
          expect(starts.has(at + found!)).toBe(true);
          // And it is the FIRST true boundary at or after `at`.
          const first = truth.entries.find(
            (b) => b.offset >= at && b.offset + 10 < at + 30_000,
          )!;
          expect(at + found!).toBe(first.offset);
        }
      }),
    );
  });

  test("the ofs-delta fixture: resync from every byte offset lands on a true boundary", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = path.join(import.meta.dirname, "fixtures", "packs");
        const pack = yield* fs.readFile(path.join(dir, "ofs-delta.pack"));
        const count = new DataView(pack.buffer, pack.byteOffset).getUint32(8);
        const truth = yield* scanBounds(pack.subarray(12), {
          base: 12,
          remaining: count,
          maxObjectSize: 1 << 20,
        });
        const starts = truth.entries.map((b) => b.offset);
        // Skip the last two entries: a boundary needs a following entry.
        const lastTestable = starts[starts.length - 2]!;
        for (let at = 12; at < lastTestable; at++) {
          const found = findBoundary(pack.subarray(at), {
            maxObjectSize: 1 << 20,
          });
          expect(found, `from ${at}`).toBeDefined();
          expect(
            starts.includes(at + found!),
            `from ${at} → ${at + found!}`,
          ).toBe(true);
        }
      }).pipe(Effect.provide(BunServices.layer)),
    );
  });
});
