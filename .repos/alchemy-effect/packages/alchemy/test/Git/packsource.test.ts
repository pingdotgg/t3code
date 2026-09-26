/**
 * The spilled-pack reader (src/Git/Store/PackSource.ts): windowed random
 * access over blob storage. Reads within a window must be VIEWS of the
 * cached slab (a copy per probe read was the 40 s spilled-push ingest), and
 * a parse through tiny windows — many window boundaries, straddling
 * entries — must produce exactly what the in-memory parse produces.
 */
import {
  hashObject,
  makeSha1,
  encodeTypeSize,
  type Oid,
} from "@/Git/Protocol/ObjectCodec.ts";
import {
  bufferRandomAccess,
  ingestPack,
  SINK_BATCH,
} from "@/Git/Protocol/PackParser.ts";
import { packHeader } from "@/Git/Protocol/PackWriter.ts";
import * as Zlib from "@/Git/Protocol/Zlib.ts";
import { makeObjectStore } from "@/Git/Store/ObjectStore.ts";
import { blobRandomAccess, sliceRandomAccess } from "@/Git/Store/PackSource.ts";
import { makeStreamingSource } from "@/Git/Store/StreamingSource.ts";
import * as Fiber from "effect/Fiber";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { concat } from "./harness/pack.ts";
import { makeMemoryBlobStore, makeTestSqlClient } from "./harness/store.ts";

/** A synthetic non-delta pack of `n` blobs with sizes cycling 100..5000. */
const buildPack = (
  n: number,
  options?: { readonly incompressible?: boolean },
) =>
  Effect.gen(function* () {
    const pieces: Array<Uint8Array> = [packHeader(n)];
    const oids: Array<Oid> = [];
    for (let i = 0; i < n; i++) {
      const size = 100 + ((i * 977) % 4900);
      const content = new Uint8Array(size);
      if (options?.incompressible) crypto.getRandomValues(content);
      else for (let j = 0; j < size; j++) content[j] = (j * 7 + i) & 0xff;
      content[0] = i & 0xff;
      oids.push(yield* hashObject(3, content));
      pieces.push(encodeTypeSize(3, size), yield* Zlib.deflate(content));
    }
    const body = concat(pieces);
    const sha = makeSha1();
    sha.update(body);
    return { pack: concat([body, sha.digest()]), oids };
  });

const parseWith = (source: ReturnType<typeof bufferRandomAccess>) =>
  Effect.gen(function* () {
    const store = makeObjectStore({
      sql: makeTestSqlClient(),
      blobs: makeMemoryBlobStore(),
      repoId: "R",
    });
    const seen: Array<string> = [];
    const offsets: Array<{
      dataOffset: number;
      zdata: Uint8Array;
      fromDelta: boolean;
    }> = [];
    const summary = yield* ingestPack({
      source,
      store,
      sink: (entry) =>
        Effect.sync(() => {
          seen.push(entry.oid);
          offsets.push({
            dataOffset: entry.dataOffset,
            zdata: entry.zdata,
            fromDelta: entry.fromDelta,
          });
        }),
    });
    return { count: summary.count, seen, offsets };
  });

describe("blobRandomAccess", () => {
  test("reads inside one window are views of the cached slab, not copies", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const blobs = makeMemoryBlobStore();
        const bytes = new Uint8Array(10_000);
        for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
        yield* blobs.put("k", bytes);
        const source = blobRandomAccess({
          blobs,
          key: "k",
          size: bytes.length,
          windowBytes: 4096,
          maxWindows: 2,
        });
        const a = yield* source.read(10, 100);
        const b = yield* source.read(200, 1000);
        expect(a.buffer).toBe(b.buffer); // same slab
        expect(a[0]).toBe(10);
        expect(b[0]).toBe(200);
        expect(blobs.gets.length).toBe(1); // one window fetch served both
        // Crossing a window boundary assembles a fresh buffer.
        const c = yield* source.read(4000, 200);
        expect(c.length).toBe(200);
        expect(c[96]).toBe(4096 & 0xff);
        expect(blobs.gets.length).toBe(2);
        // A read past the end is clipped.
        const tail = yield* source.read(9_990, 100);
        expect(tail.length).toBe(10);
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );
  });

  test("a parse through 1 KiB windows equals the in-memory parse (boundaries, straddles, eviction)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { pack, oids } = yield* buildPack(300);
        expect(pack.length).toBeGreaterThan(50_000);
        const memory = yield* parseWith(bufferRandomAccess(pack));
        const blobs = makeMemoryBlobStore();
        // Emulate the wire body: a request prefix before the pack, then the pack.
        const prefix = new TextEncoder().encode("0000".repeat(37));
        yield* blobs.put("incoming", concat([prefix, pack]));
        const spilled = sliceRandomAccess(
          blobRandomAccess({
            blobs,
            key: "incoming",
            size: prefix.length + pack.length,
            windowBytes: 1024,
            maxWindows: 3,
          }),
          prefix.length,
        );
        expect(spilled.readSync).toBeDefined();
        const windowed = yield* parseWith(spilled);
        expect(windowed.count).toBe(300);
        // dataOffset addresses the compressed span in the SOURCE (promotion
        // relies on this): reading it back yields exactly zdata.
        for (const entry of windowed.offsets.slice(0, 50)) {
          expect(entry.fromDelta).toBe(false);
          const span = yield* spilled.read(
            entry.dataOffset,
            entry.zdata.length,
          );
          expect(Array.from(span)).toEqual(Array.from(entry.zdata));
        }
        expect(windowed.seen).toEqual(memory.seen);
        expect(new Set(windowed.seen)).toEqual(new Set(oids));
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );
  });

  test("with production geometry (large windows) a sequential parse fetches about one window each", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { pack } = yield* buildPack(600, { incompressible: true });
        const blobs = makeMemoryBlobStore();
        yield* blobs.put("incoming", pack);
        const windowBytes = 64 * 1024;
        const windows = Math.ceil(pack.length / windowBytes);
        expect(windows).toBeGreaterThan(3);
        const parsed = yield* parseWith(
          blobRandomAccess({
            blobs,
            key: "incoming",
            size: pack.length,
            windowBytes,
            maxWindows: 4,
          }),
        );
        expect(parsed.count).toBe(600);
        // Every window once, plus at most one re-read per window edge an
        // entry's probe straddles (the LRU holds 4, the parse is sequential).
        expect(blobs.gets.length).toBeLessThanOrEqual(windows * 2);
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );
  });
});

describe("synchronous fast path", () => {
  test("with a batched sink, non-delta entries arrive in runs of ≤ SINK_BATCH and the per-entry sink sees none", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { pack, oids } = yield* buildPack(700);
        const store = makeObjectStore({
          sql: makeTestSqlClient(),
          blobs: makeMemoryBlobStore(),
          repoId: "R",
        });
        const batches: Array<number> = [];
        const single: Array<string> = [];
        const seen = new Set<string>();
        const summary = yield* ingestPack({
          source: bufferRandomAccess(pack),
          store,
          sink: (entry) =>
            Effect.sync(() => {
              single.push(entry.oid);
            }),
          sinkBatch: (entries) =>
            Effect.sync(() => {
              batches.push(entries.length);
              for (const e of entries) seen.add(e.oid);
            }),
        });
        expect(summary.count).toBe(700);
        expect(single).toEqual([]);
        expect(batches.every((n) => n <= SINK_BATCH && n > 0)).toBe(true);
        expect(batches.reduce((a, b) => a + b, 0)).toBe(700);
        expect(seen).toEqual(new Set(oids));
      }),
    );
  });
});

describe("parsing a pack while it streams in (DESIGN §22.6)", () => {
  test(
    "parse runs concurrently with the feed, in random chunk sizes, and verifies the trailer",
    async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const { pack, oids } = yield* buildPack(500, {
            incompressible: true,
          });
          const feeder = makeStreamingSource({
            slabBytes: 64 * 1024,
            retainBytes: 256 * 1024,
            backpressureBytes: 128 * 1024,
          });
          const prefix = new TextEncoder().encode(
            "0021push refs/heads/main x\n0000".padEnd(37, "\0"),
          );
          const parse = yield* Effect.forkChild(
            parseWith(sliceRandomAccess(feeder.source, prefix.length)),
          );
          const body = concat([prefix, pack]);
          let at = 0;
          let seed = 7;
          while (at < body.length) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            const n = 1 + (seed % 20_000);
            yield* feeder.push(body.subarray(at, at + n));
            at += n;
            if (seed % 5 === 0) yield* Effect.yieldNow;
          }
          feeder.end();
          const parsed = yield* Fiber.join(parse);
          expect(parsed.count).toBe(500);
          expect(new Set(parsed.seen)).toEqual(new Set(oids));
        }),
      );
    },
    { timeout: 30_000 },
  );

  test("a body that ends early is a truncated-pack error, not a hang", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { pack } = yield* buildPack(50);
        const feeder = makeStreamingSource({ slabBytes: 4096 });
        const parse = yield* Effect.forkChild(
          Effect.result(parseWith(feeder.source)),
        );
        yield* feeder.push(pack.subarray(0, Math.floor(pack.length / 2)));
        feeder.end();
        const r = yield* Fiber.join(parse);
        expect(r._tag).toBe("Failure");
      }),
    );
  });

  test("a corrupted trailer is rejected even though the hash is accumulated incrementally", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { pack } = yield* buildPack(20);
        const bad = Uint8Array.from(pack);
        bad[bad.length - 1] ^= 0xff;
        const r = yield* Effect.result(parseWith(bufferRandomAccess(bad)));
        expect(r._tag).toBe("Failure");
        if (r._tag === "Failure")
          expect(String(r.failure._tag)).toBe("PackChecksumMismatch");
      }),
    );
  });
});
