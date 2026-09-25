/**
 * The hasher-driven ingest (src/Git/RepoObject.ts `ingestPackFrom` with a
 * hasher, DESIGN §22.7) over the store harness: tiny parts force every
 * delta base into an earlier part, so cross-part resolution after the end
 * and thin-pack bases from the store are exercised in-process.
 */
import * as BunServices from "@effect/platform-bun/BunServices";
import { bufferRandomAccess } from "@/Git/Protocol/PackParser.ts";
import { HasherInline, Hasher, type HasherShape } from "@/Git/Hasher/Hasher.ts";
import { ingestPackFrom, ingestStoreOf } from "@/Git/RepoObject.ts";
import { makeObjectStore } from "@/Git/Store/ObjectStore.ts";
import { makeStreamingSource } from "@/Git/Store/StreamingSource.ts";
import { sliceRandomAccess } from "@/Git/Store/PackSource.ts";
import {
  hashObject,
  encodeTypeSize,
  makeSha1,
} from "@/Git/Protocol/ObjectCodec.ts";
import { packHeader } from "@/Git/Protocol/PackWriter.ts";
import * as Zlib from "@/Git/Protocol/Zlib.ts";
import * as Fiber from "effect/Fiber";
import { concat } from "./harness/pack.ts";
import { describe, expect, test } from "alchemy-test";
import { BlobStore } from "@/Git/BlobStore.ts";
import * as Effect from "effect/Effect";
import { RuntimeContext } from "@/RuntimeContext.ts";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { makeMemoryBlobStore, makeTestSqlClient } from "./harness/store.ts";

const fixture = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(import.meta.dirname, "fixtures", "packs");
    const pack = yield* fs.readFile(path.join(dir, name));
    const manifest = JSON.parse(
      yield* fs.readFileString(path.join(dir, "manifest.json")),
    ) as {
      packs: Record<string, { oids: ReadonlyArray<string> }>;
    };
    return { pack, manifest };
  });

describe("ingestPackFrom through the hasher", () => {
  test("ofs-delta fixture in 64-byte parts: every object staged, cross-part deltas resolved after the end", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { pack, manifest } = yield* fixture("ofs-delta.pack");
        const sql = makeTestSqlClient();
        const store = makeObjectStore({
          sql,
          blobs: makeMemoryBlobStore(),
          repoId: "R",
        });
        const hasher = yield* Hasher;
        const outcome = yield* Effect.result(
          ingestPackFrom(bufferRandomAccess(pack), {
            store: ingestStoreOf(store),
            pushId: "push-1",
            hasher,
            partBytes: 64,
          }),
        );
        if (outcome._tag === "Failure")
          throw new Error(`${outcome.failure._tag}: ${outcome.failure.reason}`);
        const result = outcome.success;
        const expected = manifest.packs["ofs-delta"]!.oids;
        expect(result.objectCount).toBe(expected.length);
        const staged = yield* sql.all<{ oid: string }>(
          `SELECT oid FROM objects WHERE staged_push = 'push-1' ORDER BY oid`,
        );
        expect(staged.map((r) => r.oid)).toEqual([...expected].sort());
      }).pipe(
        Effect.provide(
          HasherInline.pipe(
            Layer.provide(Layer.succeed(BlobStore, makeMemoryBlobStore())),
          ),
        ),
        Effect.provide(BunServices.layer),
      ),
    );
  });

  test("a corrupted trailer is rejected by the pipeline's lagged hash", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { pack } = yield* fixture("simple.pack");
        const bad = Uint8Array.from(pack);
        bad[bad.length - 3] ^= 0x01;
        const store = makeObjectStore({
          sql: makeTestSqlClient(),
          blobs: makeMemoryBlobStore(),
          repoId: "R",
        });
        const hasher = yield* Hasher;
        const r = yield* Effect.result(
          ingestPackFrom(bufferRandomAccess(bad), {
            store: ingestStoreOf(store),
            pushId: "p",
            hasher,
            partBytes: 4096,
          }),
        );
        expect(r._tag).toBe("Failure");
        if (r._tag === "Failure")
          expect(r.failure.reason).toContain("checksum");
      }).pipe(
        Effect.provide(
          HasherInline.pipe(
            Layer.provide(Layer.succeed(BlobStore, makeMemoryBlobStore())),
          ),
        ),
        Effect.provide(BunServices.layer),
      ),
    );
  });
});

describe("hasher pipeline over a streaming source with eviction", () => {
  test(
    "a multi-part pack whose retained window is smaller than a part stages every inline row and completes (no fallback)",
    async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const n = 1500;
          const pieces: Array<Uint8Array> = [packHeader(n)];
          for (let i = 0; i < n; i++) {
            const c = new Uint8Array(1000 + (i % 700));
            crypto.getRandomValues(c);
            yield* hashObject(3, c);
            pieces.push(encodeTypeSize(3, c.length), yield* Zlib.deflate(c));
          }
          const body = concat(pieces);
          const sha = makeSha1();
          sha.update(body);
          const pack = concat([body, sha.digest()]);
          // Parts of 64 KiB, retention of 128 KiB, no spill/fallback: every
          // inline row must be read back before its bytes are dropped.
          const feeder = makeStreamingSource({
            slabBytes: 32 * 1024,
            retainBytes: 128 * 1024,
            backpressureBytes: 1 << 20,
          });
          const sql = makeTestSqlClient();
          const store = makeObjectStore({
            sql,
            blobs: makeMemoryBlobStore(),
            repoId: "R",
          });
          const hasher = yield* Hasher;
          const ingest = yield* Effect.forkChild(
            Effect.result(
              ingestPackFrom(feeder.source, {
                store: ingestStoreOf(store),
                pushId: "p",
                hasher,
                partBytes: 64 * 1024,
              }),
            ),
          );
          for (let at = 0; at < pack.length; at += 50_000)
            yield* feeder.push(pack.subarray(at, at + 50_000));
          feeder.end();
          const r = yield* Fiber.join(ingest).pipe(
            Effect.timeout("20 seconds"),
          );
          expect(r._tag).toBe("Success");
          const staged = yield* sql.first<{ n: number; withBytes: number }>(
            `SELECT COUNT(*) AS n, SUM(LENGTH(zdata) > 0) AS withBytes FROM objects WHERE staged_push = 'p'`,
          );
          expect(staged?.n).toBe(n);
          expect(staged?.withBytes).toBe(n);
        }).pipe(
          Effect.provide(
            HasherInline.pipe(
              Layer.provide(Layer.succeed(BlobStore, makeMemoryBlobStore())),
            ),
          ),
        ),
      );
    },
    { timeout: 30_000 },
  );
});

describe("raw-chunk dispatch with resync and stitching (DESIGN §22.9)", () => {
  test("the ofs-delta fixture in 64-byte chunks: every straddler stitched, every delta resolved", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { pack, manifest } = yield* fixture("ofs-delta.pack");
        const sql = makeTestSqlClient();
        const store = makeObjectStore({
          sql,
          blobs: makeMemoryBlobStore(),
          repoId: "R",
        });
        const hasher = yield* Hasher;
        for (const partBytes of [64, 200, 1000, 1 << 20]) {
          yield* sql.run(`DELETE FROM objects`);
          const outcome = yield* Effect.result(
            ingestPackFrom(bufferRandomAccess(pack), {
              store: ingestStoreOf(store),
              pushId: "p",
              hasher,
              partBytes,
            }),
          );
          if (outcome._tag === "Failure")
            throw new Error(
              `parts of ${partBytes}: ${outcome.failure._tag}: ${outcome.failure.reason}`,
            );
          const result = outcome.success;
          const expected = manifest.packs["ofs-delta"]!.oids;
          expect(result.objectCount, `parts of ${partBytes}`).toBe(
            expected.length,
          );
          const staged = yield* sql.all<{ oid: string }>(
            `SELECT oid FROM objects WHERE staged_push = 'p' ORDER BY oid`,
          );
          expect(
            staged.map((r) => r.oid),
            `parts of ${partBytes}`,
          ).toEqual([...expected].sort());
        }
      }).pipe(
        Effect.provide(
          HasherInline.pipe(
            Layer.provide(Layer.succeed(BlobStore, makeMemoryBlobStore())),
          ),
        ),
        Effect.provide(BunServices.layer),
      ),
    );
  });
});

describe("spill by the hasher (DESIGN §22.10)", () => {
  /** A pack of `n` random blobs plus a fake command section in front. */
  const makeBody = (n: number, blobBytes: number, headBytes: number) =>
    Effect.gen(function* () {
      const pieces: Array<Uint8Array> = [packHeader(n)];
      for (let i = 0; i < n; i++) {
        const c = new Uint8Array(blobBytes + (i % 97));
        crypto.getRandomValues(c);
        pieces.push(encodeTypeSize(3, c.length), yield* Zlib.deflate(c));
      }
      const packBody = concat(pieces);
      const sha = makeSha1();
      sha.update(packBody);
      const pack = concat([packBody, sha.digest()]);
      const head = new Uint8Array(headBytes);
      head.fill(0x20);
      return { body: concat([head, pack]), packStart: headBytes };
    });

  const run = (
    opts: {
      readonly n: number;
      readonly blobBytes: number;
      readonly headBytes: number;
      readonly partBytes: number;
      readonly threshold: number;
      readonly chunk: number;
    },
    hasherOverride?: HasherShape,
  ) =>
    Effect.gen(function* () {
      const { body, packStart } = yield* makeBody(
        opts.n,
        opts.blobBytes,
        opts.headBytes,
      );
      // ONE blob store: the hasher writes the parts the pump's upload
      // collects — in production both are the same BlobStore layer.
      const blobs = yield* BlobStore;
      const feeder = makeStreamingSource({
        slabBytes: opts.partBytes,
        retainBytes: opts.partBytes * 2,
        backpressureBytes: 1 << 20,
      });
      const sql = makeTestSqlClient();
      const store = makeObjectStore({ sql, blobs, repoId: "R" });
      const hasher = hasherOverride ?? (yield* Hasher);
      const source = sliceRandomAccess(feeder.source, packStart);
      const ingest = yield* Effect.forkChild(
        Effect.result(
          ingestPackFrom(source, {
            store: ingestStoreOf(store),
            pushId: "p",
            hasher,
            partBytes: opts.partBytes,
            spill: {
              body: feeder.source,
              feeder,
              packStart,
              blobs,
              key: "R/incoming/X.pack",
              packId: "wire-X",
              repoId: "R",
              threshold: opts.threshold,
            },
          }),
        ),
      );
      for (let at = 0; at < body.length; at += opts.chunk)
        yield* feeder.push(body.subarray(at, at + opts.chunk));
      feeder.end();
      const r = yield* Fiber.join(ingest).pipe(Effect.timeout("20 seconds"));
      if (r._tag === "Failure") throw new Error(r.failure.reason);
      const rows = yield* sql.first<{ n: number; promoted: number }>(
        `SELECT COUNT(*) AS n, SUM(location = 'pack') AS promoted FROM objects WHERE staged_push = 'p'`,
      );
      const spilled = yield* blobs.head("R/incoming/X.pack");
      return { result: r.success, rows, spilled, body, blobs };
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          HasherInline,
          Layer.succeed(BlobStore, makeMemoryBlobStore()),
        ),
      ),
      Effect.provide(RuntimeContext.phantom),
    );

  test(
    "a body past the threshold is written whole by the parts' hashers; blobs are promoted into it",
    async () => {
      const out = await Effect.runPromise(
        run({
          n: 400,
          blobBytes: 600,
          headBytes: 137,
          partBytes: 32 * 1024,
          threshold: 8 * 1024,
          chunk: 7_001,
        }),
      );
      expect(out.result.parkedKey).toBe("R/incoming/X.pack");
      expect(out.spilled?.size).toBe(out.body.length);
      const stored = await Effect.runPromise(
        Effect.gen(function* () {
          const blob = yield* out.blobs.get("R/incoming/X.pack");
          return blob === null ? undefined : yield* blob.bytes;
        }).pipe(Effect.provide(RuntimeContext.phantom)),
      );
      expect(stored).toEqual(out.body);
      expect(out.rows?.n).toBe(400);
      expect(out.rows?.promoted).toBe(400);
      expect(out.result.promoted).toBe(400);
    },
    { timeout: 30_000 },
  );

  test(
    "a hasher that cannot write the spill (writesSpill=false, small chunks): the pump uploads the parts itself",
    async () => {
      const out = await Effect.runPromise(
        Effect.gen(function* () {
          const inline = yield* Hasher;
          // A Lambda-shaped hasher: chunks a quarter of a part, no spill.
          const lambdaLike: HasherShape = {
            writesSpill: false,
            chunkBytes: 8 * 1024,
            hashPart: (payload, opts) => {
              if (opts.spill !== undefined) {
                throw new Error(
                  "spill must not be requested from a non-spilling hasher",
                );
              }
              return inline.hashPart(payload, opts);
            },
            hashBoundsPart: inline.hashBoundsPart,
            resolveDeltas: inline.resolveDeltas,
          };
          return yield* run(
            {
              n: 400,
              blobBytes: 600,
              headBytes: 137,
              partBytes: 32 * 1024,
              threshold: 8 * 1024,
              chunk: 7_001,
            },
            lambdaLike,
          );
        }).pipe(
          Effect.provide(
            Layer.provideMerge(
              HasherInline,
              Layer.succeed(BlobStore, makeMemoryBlobStore()),
            ),
          ),
          Effect.provide(RuntimeContext.phantom),
        ),
      );
      expect(out.result.parkedKey).toBe("R/incoming/X.pack");
      expect(out.spilled?.size).toBe(out.body.length);
      const stored = await Effect.runPromise(
        Effect.gen(function* () {
          const blob = yield* out.blobs.get("R/incoming/X.pack");
          return blob === null ? undefined : yield* blob.bytes;
        }).pipe(Effect.provide(RuntimeContext.phantom)),
      );
      expect(stored).toEqual(out.body);
      expect(out.rows?.n).toBe(400);
      expect(out.rows?.promoted).toBe(400);
    },
    { timeout: 30_000 },
  );

  test(
    "a body that ends within the threshold stays in memory: nothing written, rows inline",
    async () => {
      const out = await Effect.runPromise(
        run({
          n: 20,
          blobBytes: 100,
          headBytes: 50,
          partBytes: 32 * 1024,
          threshold: 64 * 1024,
          chunk: 1_000,
        }),
      );
      expect(out.result.parkedKey).toBeUndefined();
      expect(out.spilled).toBeNull();
      expect(out.rows?.n).toBe(20);
      expect(out.rows?.promoted).toBe(0);
    },
    { timeout: 30_000 },
  );
});
