/**
 * Object store unit tests (src/Git/Store/ObjectStore.ts, Jobs/Compact.ts)
 * over the bun:sqlite + in-memory blob harness. Every emitted pack is
 * re-parsed by the real pack parser, so the bytes — not just the counts —
 * are verified.
 */
import {
  encodeTypeSize,
  makeSha1,
  hashObject,
  type Oid,
  type ObjectType,
} from "@/Git/Protocol/ObjectCodec.ts";
import { bufferRandomAccess, ingestPack } from "@/Git/Protocol/PackParser.ts";
import { packHeader } from "@/Git/Protocol/PackWriter.ts";
import type { ManifestEntry } from "@/Git/Protocol/Store.ts";
import * as Zlib from "@/Git/Protocol/Zlib.ts";
import {
  runCompactJob,
  runGeometricMergeJob,
  shouldCompact,
  BLOB_TYPE,
} from "@/Git/Jobs/Compact.ts";
import { packKey, packKeyOf, wirePackId } from "@/Git/Store/Keys.ts";
import {
  makeObjectStore,
  STAGE_INSERT_ROWS,
  WINDOW_BYTES,
  WINDOW_CACHE_BYTES,
} from "@/Git/Store/ObjectStore.ts";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import { RuntimeContext } from "@/RuntimeContext.ts";
import * as Stream from "effect/Stream";
import { concat, verifyPack } from "./harness/pack.ts";
import { makeMemoryBlobStore, makeTestSqlClient } from "./harness/store.ts";

const REPO = "01TESTREPO0000000000000000";

/** Runs an effect, surfacing typed failures with their fields (not just `message`). */
const run = <A>(effect: Effect.Effect<A, unknown, RuntimeContext>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(RuntimeContext.phantom),
      Effect.mapError((e) =>
        e instanceof Error && !("reason" in e)
          ? e
          : new Error(JSON.stringify(e)),
      ),
    ),
  );

/** Incompressible bytes; `seed` only guarantees distinct content per call. */
const bytes = (n: number, seed: number) => {
  const out = new Uint8Array(n);
  for (let at = 0; at < n; at += 65536) {
    crypto.getRandomValues(out.subarray(at, Math.min(at + 65536, n)));
  }
  out[0] = seed & 0xff;
  return out;
};

interface Fixture {
  readonly oid: Oid;
  readonly type: ObjectType;
  readonly content: Uint8Array;
  readonly zdata: Uint8Array;
}

const makeFixture = (type: ObjectType, content: Uint8Array) =>
  Effect.gen(function* () {
    const oid = yield* hashObject(type, content);
    const zdata = yield* Zlib.deflate(content);
    return { oid, type, content, zdata } satisfies Fixture;
  });

/** A repo with `blobs` incompressible blobs of `blobSize` and `trees` small trees. */
const seedRepo = (options: {
  blobs: number;
  blobSize: number;
  trees: number;
}) =>
  Effect.gen(function* () {
    const sql = makeTestSqlClient();
    const blobs = makeMemoryBlobStore();
    const store = makeObjectStore({ sql, blobs, repoId: REPO });
    const fixtures: Array<Fixture> = [];
    for (let i = 0; i < options.blobs; i++) {
      fixtures.push(yield* makeFixture(3, bytes(options.blobSize, i + 1)));
    }
    for (let i = 0; i < options.trees; i++) {
      // Not a real tree encoding; the store never parses tree bytes here.
      fixtures.push(
        yield* makeFixture(
          2,
          new TextEncoder().encode(`tree ${i} ${"x".repeat(40)}`),
        ),
      );
    }
    yield* sql.transactionSync((raw) => {
      for (const f of fixtures) {
        raw.exec(
          `INSERT INTO objects (oid, type, size, zsize, location, zdata) VALUES (?, ?, ?, ?, 'row', ?)`,
          f.oid,
          f.type,
          f.content.length,
          f.zdata.length,
          f.zdata.buffer.slice(
            f.zdata.byteOffset,
            f.zdata.byteOffset + f.zdata.byteLength,
          ),
        );
      }
    });
    return { sql, blobs, store, fixtures };
  });

const manifestOf = (
  fixtures: ReadonlyArray<Fixture>,
  location: ManifestEntry["location"],
) =>
  fixtures.map((f): ManifestEntry => ({
    oid: f.oid,
    type: f.type,
    size: f.content.length,
    zsize: f.zdata.length,
    location,
  }));

/** Emits a full pack (header + entries + trailer) through `packEntries`. */
const buildPack = (
  store: ReturnType<typeof makeObjectStore>,
  entries: ReadonlyArray<ManifestEntry>,
) =>
  Effect.gen(function* () {
    const body = Array.from(
      yield* Stream.runCollect(store.packEntries(entries)),
    );
    const head = packHeader(entries.length);
    const sha = makeSha1();
    sha.update(head);
    for (const b of body) sha.update(b);
    return concat([head, ...body, sha.digest()]);
  });

/** Parses a pack with the real parser and returns the oids it yields. */
const parsePack = (
  pack: Uint8Array,
  store: ReturnType<typeof makeObjectStore>,
) =>
  Effect.gen(function* () {
    const seen = new Map<string, number>();
    const summary = yield* ingestPack({
      source: bufferRandomAccess(pack),
      store,
      sink: (entry) =>
        Effect.sync(() => {
          seen.set(entry.oid, entry.size);
        }),
    });
    return { count: summary.count, seen };
  });

const compactAll = (
  sql: ReturnType<typeof makeTestSqlClient>,
  blobs: ReturnType<typeof makeMemoryBlobStore>,
  maxObjects = 100,
) =>
  Effect.gen(function* () {
    const packIds: Array<string> = [];
    for (;;) {
      const out = yield* runCompactJob({
        repoId: REPO,
        sql,
        blobs,
        maxObjects,
        maxBytes: 64 * 1024 * 1024,
      });
      if (out.packId !== undefined) packIds.push(out.packId);
      if (!out.more) break;
    }
    return packIds;
  });

describe("compaction is blob-only", { tags: ["unit", "local"] }, () => {
  test("shouldCompact ignores commits/trees; runCompactJob leaves them as rows", async () => {
    await run(
      Effect.gen(function* () {
        const { sql, blobs, fixtures } = yield* seedRepo({
          blobs: 5,
          blobSize: 100,
          trees: 50,
        });
        expect(BLOB_TYPE).toBe(3);
        // 55 rows total, but only 5 blobs: below a count threshold of 10.
        expect(
          yield* shouldCompact(sql, {
            countThreshold: 10,
            bytesThreshold: 1 << 30,
          }),
        ).toBe(false);
        expect(
          yield* shouldCompact(sql, {
            countThreshold: 5,
            bytesThreshold: 1 << 30,
          }),
        ).toBe(true);
        const packs = yield* compactAll(sql, blobs);
        expect(packs.length).toBe(1);
        const rows = yield* sql.all<{
          location: string;
          type: number;
          n: number;
        }>(
          `SELECT location, type, COUNT(*) AS n FROM objects GROUP BY location, type ORDER BY location, type`,
        );
        expect(rows).toEqual([
          { location: "pack", type: 3, n: 5 },
          { location: "row", type: 2, n: 50 },
        ]);
        expect(
          yield* runCompactJob({ repoId: REPO, sql, blobs }),
        ).toMatchObject({ moved: 0, more: false });
        expect(fixtures.length).toBe(55);
      }),
    );
  });
});

describe("packEntries", { tags: ["unit", "local"] }, () => {
  test(
    "rows + multi-window pack (with straddling objects) emit a pack the parser accepts",
    async () => {
      await run(
        Effect.gen(function* () {
          // 300 × 30 KiB incompressible ≈ 9 MiB → 3 windows, with objects
          // straddling both window edges.
          const { sql, blobs, store, fixtures } = yield* seedRepo({
            blobs: 300,
            blobSize: 30 * 1024,
            trees: 40,
          });
          const packs = yield* compactAll(sql, blobs, 1000); // one pack
          expect(packs.length).toBe(1);
          const packBytes = blobs.objects.get(packKey(REPO, packs[0]!))!;
          expect(packBytes.length).toBeGreaterThan(2 * WINDOW_BYTES); // 3 windows
          const coords = yield* sql.all<{ pack_id: string; n: number }>(
            `SELECT pack_id, COUNT(*) AS n FROM objects WHERE location='pack' GROUP BY pack_id`,
          );
          expect(coords.map((c) => c.n)).toEqual([300]);

          // Manifest in the order a closure would produce (trees first).
          const entries = [
            ...manifestOf(
              fixtures.filter((f) => f.type === 2),
              "row",
            ),
            ...manifestOf(
              fixtures.filter((f) => f.type === 3),
              "pack",
            ),
          ];
          blobs.gets.length = 0;
          const pack = yield* buildPack(store, entries);
          expect(verifyPack(pack).error).toBeUndefined();
          const parsed = yield* parsePack(pack, store);
          expect(parsed.count).toBe(340);
          expect(parsed.seen.size).toBe(340);
          for (const f of fixtures)
            expect(parsed.seen.get(f.oid)).toBe(f.content.length);

          // One ranged GET per window touched, not per object.
          const windowGets = blobs.gets.filter(
            (g) => g.length === WINDOW_BYTES,
          );
          const straddleGets = blobs.gets.filter(
            (g) => g.length !== WINDOW_BYTES,
          );
          expect(windowGets.length).toBe(3);
          expect(straddleGets.length).toBeLessThanOrEqual(2); // ≤ one per window edge
        }),
      );
    },
    { timeout: 60_000 },
  );

  test("a manifest entry that compaction moved after the closure is still emitted (re-dispatch)", async () => {
    await run(
      Effect.gen(function* () {
        const { sql, blobs, store, fixtures } = yield* seedRepo({
          blobs: 20,
          blobSize: 2048,
          trees: 3,
        });
        // The closure saw everything as rows…
        const entries = manifestOf(fixtures, "row");
        // …then compaction ran before emission.
        yield* compactAll(sql, blobs);
        const pack = yield* buildPack(store, entries);
        expect(verifyPack(pack).error).toBeUndefined();
        const parsed = yield* parsePack(pack, store);
        expect(parsed.seen.size).toBe(23);
      }),
    );
  });

  test("a truly absent object fails the stream instead of emitting a short pack", async () => {
    await run(
      Effect.gen(function* () {
        const { store, fixtures } = yield* seedRepo({
          blobs: 2,
          blobSize: 100,
          trees: 0,
        });
        const ghost = {
          ...manifestOf(fixtures, "row")[0]!,
          oid: "0".repeat(40) as Oid,
        };
        const result = yield* Effect.result(
          Stream.runCollect(store.packEntries([ghost])),
        );
        expect(result._tag).toBe("Failure");
      }),
    );
  });
});

describe("readContentBatch", { tags: ["unit", "local"] }, () => {
  test("returns inflated content for rows and packed objects alike", async () => {
    await run(
      Effect.gen(function* () {
        const { sql, blobs, store, fixtures } = yield* seedRepo({
          blobs: 30,
          blobSize: 512,
          trees: 10,
        });
        yield* compactAll(sql, blobs);
        const out = yield* store.readContentBatch(fixtures.map((f) => f.oid));
        expect(out.size).toBe(40);
        for (const f of fixtures) {
          expect(Array.from(out.get(f.oid)!)).toEqual(Array.from(f.content));
        }
      }),
    );
  });
});

describe("window cache", { tags: ["unit", "local"] }, () => {
  test(
    "is bounded by WINDOW_CACHE_BYTES: re-reading the first of nine windows refetches",
    async () => {
      await run(
        Effect.gen(function* () {
          // 36 × 1 MiB incompressible → one 36 MiB pack = 9 windows > 8 cached.
          const { sql, blobs, store, fixtures } = yield* seedRepo({
            blobs: 36,
            blobSize: 1024 * 1024,
            trees: 0,
          });
          const out = yield* runCompactJob({
            repoId: REPO,
            sql,
            blobs,
            maxObjects: 100,
            maxBytes: 64 * 1024 * 1024,
          });
          expect(out.moved).toBe(36);
          expect(WINDOW_CACHE_BYTES / WINDOW_BYTES).toBe(8);
          const sorted = [...fixtures];
          const order = yield* sql.all<{
            oid: string;
            pack_offset: number;
            zsize: number;
          }>(
            `SELECT oid, pack_offset, zsize FROM objects ORDER BY pack_offset`,
          );
          const byOid = new Map(sorted.map((f) => [f.oid, f]));
          const first = byOid.get(order[0]!.oid as Oid)!;
          // An object lying entirely inside window 7 (objects that straddle a
          // window edge take a ranged read that bypasses the cache by design).
          const inside7 = order.find(
            (r) =>
              Math.floor(r.pack_offset / WINDOW_BYTES) === 7 &&
              r.pack_offset + r.zsize <= 8 * WINDOW_BYTES,
          )!;
          const last = byOid.get(inside7.oid as Oid)!;
          blobs.gets.length = 0;
          yield* store.readContentBatch([first.oid]);
          const afterFirst = blobs.gets.length;
          expect(afterFirst).toBeGreaterThanOrEqual(1);
          // Touch every window.
          yield* store.readContentBatch(order.map((r) => r.oid as Oid));
          blobs.gets.length = 0;
          // The first window has been evicted (9 > 8): reading it fetches again.
          yield* store.readContentBatch([first.oid]);
          expect(blobs.gets.length).toBeGreaterThanOrEqual(1);
          // The last window is still hot: no fetch.
          blobs.gets.length = 0;
          yield* store.readContentBatch([last.oid]);
          expect(blobs.gets.length).toBe(0);
        }),
      );
    },
    { timeout: 60_000 },
  );
});

describe("insertStagedBatch", { tags: ["unit", "local"] }, () => {
  test("stages a batch with multi-row inserts; staged rows are invisible to live reads", async () => {
    await run(
      Effect.gen(function* () {
        const sql = makeTestSqlClient();
        const store = makeObjectStore({
          sql,
          blobs: makeMemoryBlobStore(),
          repoId: REPO,
        });
        const objects = [];
        for (let i = 0; i < STAGE_INSERT_ROWS * 2 + 7; i++) {
          const f = yield* makeFixture(3, bytes(64, i + 1));
          objects.push({
            oid: f.oid,
            type: f.type,
            size: f.content.length,
            zdata: f.zdata,
          });
        }
        yield* store.insertStagedBatch("push-A", objects);
        const staged = yield* sql.first<{ n: number }>(
          `SELECT COUNT(*) AS n FROM objects WHERE staged_push = 'push-A'`,
        );
        expect(staged?.n).toBe(objects.length);
        expect(yield* store.has(objects[0]!.oid)).toBe(false);
      }),
    );
  });

  test("a committed push's rows are live before the flip, cannot be adopted, and GC flips them (DESIGN §22.14)", async () => {
    await run(
      Effect.gen(function* () {
        const sql = makeTestSqlClient();
        const store = makeObjectStore({
          sql,
          blobs: makeMemoryBlobStore(),
          repoId: REPO,
        });
        const objects = [];
        for (let i = 0; i < 6; i++) {
          const f = yield* makeFixture(3, bytes(64, i + 300));
          objects.push({
            oid: f.oid,
            type: f.type,
            size: f.content.length,
            zdata: f.zdata,
          });
        }
        yield* sql.run(
          `INSERT INTO pushes (push_id, started_at, state) VALUES ('push-live', ?, 'committed')`,
          Date.now(),
        );
        yield* store.insertStagedBatch("push-live", objects);
        // Live for readers although `staged_push` is still set.
        expect(yield* store.has(objects[0]!.oid)).toBe(true);
        const missing = yield* store.missingObjects(
          objects.map((o) => o.oid),
          "push-other",
        );
        expect(missing).toEqual([]);
        // A later push re-staging the same oids must not steal them.
        yield* store.insertStagedBatch("push-other", objects.slice(0, 3));
        const still = yield* sql.first<{ n: number }>(
          `SELECT COUNT(*) AS n FROM objects WHERE staged_push = 'push-live'`,
        );
        expect(still?.n).toBe(6);
        // The deferred flip (here: what GC does) nulls the column.
        yield* sql.run(
          `UPDATE objects SET staged_push = NULL WHERE staged_push IN (SELECT push_id FROM pushes WHERE state = 'committed')`,
        );
        const flipped = yield* sql.first<{ n: number }>(
          `SELECT COUNT(*) AS n FROM objects WHERE staged_push IS NULL`,
        );
        expect(flipped?.n).toBe(6);
        expect(yield* store.has(objects[5]!.oid)).toBe(true);
      }),
    );
  });

  test("rows left by a crashed push are adopted; live objects are left alone", async () => {
    await run(
      Effect.gen(function* () {
        const sql = makeTestSqlClient();
        const store = makeObjectStore({
          sql,
          blobs: makeMemoryBlobStore(),
          repoId: REPO,
        });
        const objects = [];
        for (let i = 0; i < 10; i++) {
          const f = yield* makeFixture(3, bytes(64, i + 100));
          objects.push({
            oid: f.oid,
            type: f.type,
            size: f.content.length,
            zdata: f.zdata,
          });
        }
        yield* store.insertStagedBatch("push-crashed", objects.slice(0, 4));
        yield* store.insertStagedBatch("push-B", objects);
        const byPush = yield* sql.all<{ staged_push: string; n: number }>(
          `SELECT staged_push, COUNT(*) AS n FROM objects GROUP BY staged_push`,
        );
        expect(byPush).toEqual([{ staged_push: "push-B", n: 10 }]);
        yield* sql.run(
          `UPDATE objects SET staged_push = NULL WHERE oid = ?`,
          objects[0]!.oid,
        );
        yield* store.insertStagedBatch("push-C", objects.slice(0, 2));
        const live = yield* sql.first<{ staged_push: string | null }>(
          `SELECT staged_push FROM objects WHERE oid = ?`,
          objects[0]!.oid,
        );
        expect(live?.staged_push).toBeNull();
        const other = yield* sql.first<{ staged_push: string | null }>(
          `SELECT staged_push FROM objects WHERE oid = ?`,
          objects[1]!.oid,
        );
        expect(other?.staged_push).toBe("push-C");
      }),
    );
  });
});

describe(
  "promoted wire packs (DESIGN §22.5)",
  { tags: ["unit", "local"] },
  () => {
    /** Lays fixtures out the way a wire pack does: typeSize header + zdata per entry. */
    const layout = (fixtures: ReadonlyArray<Fixture>, base: number) => {
      const pieces: Array<Uint8Array> = [new Uint8Array(base)];
      const offsets = new Map<Oid, number>();
      let at = base;
      for (const f of fixtures) {
        const head = encodeTypeSize(f.type as 3, f.content.length);
        pieces.push(head, f.zdata);
        offsets.set(f.oid, at + head.length);
        at += head.length + f.zdata.length;
      }
      return { bytes: concat(pieces), offsets };
    };

    test("rows staged as pack references read back through the wire key on every path", async () => {
      await run(
        Effect.gen(function* () {
          const sql = makeTestSqlClient();
          const blobs = makeMemoryBlobStore();
          const store = makeObjectStore({ sql, blobs, repoId: REPO });
          const fixtures: Array<Fixture> = [];
          for (let i = 0; i < 40; i++)
            fixtures.push(yield* makeFixture(3, bytes(3000, i + 1)));
          const packId = wirePackId("01RECEIVE00000000000000000");
          const { bytes: wire, offsets } = layout(fixtures, 137); // 137 bytes of pkt-line commands first
          yield* blobs.put(packKeyOf(REPO, packId), wire);
          expect(packKeyOf(REPO, packId)).toContain("/incoming/");
          yield* store.insertStagedBatch(
            "push-P",
            fixtures.map((f) => ({
              oid: f.oid,
              type: f.type,
              size: f.content.length,
              zdata: f.zdata,
              pack: { packId, offset: offsets.get(f.oid)! },
            })),
          );
          const staged = yield* sql.all<{
            location: string;
            n: number;
            withBlob: number;
          }>(
            `SELECT location, COUNT(*) AS n, SUM(zdata IS NOT NULL) AS withBlob FROM objects GROUP BY location`,
          );
          expect(staged).toEqual([{ location: "pack", n: 40, withBlob: 0 }]);
          yield* sql.run(
            `UPDATE objects SET staged_push = NULL WHERE staged_push = 'push-P'`,
          );
          // Single reads, batched reads, and pack emission all resolve the wire key.
          const one = yield* store.readContent(fixtures[7]!.oid);
          expect(Array.from(one)).toEqual(Array.from(fixtures[7]!.content));
          const many = yield* store.readContentBatch(
            fixtures.map((f) => f.oid),
          );
          expect(many.size).toBe(40);
          const pack = yield* buildPack(store, manifestOf(fixtures, "pack"));
          expect(verifyPack(pack).error).toBeUndefined();
          const parsed = yield* parsePack(
            pack,
            makeObjectStore({
              sql: makeTestSqlClient(),
              blobs: makeMemoryBlobStore(),
              repoId: "X",
            }),
          );
          expect(parsed.seen.size).toBe(40);
        }),
      );
    });

    test("compaction leaves promoted rows alone; geometric merge REWRITES a wire pack into the merged pack", async () => {
      await run(
        Effect.gen(function* () {
          const { sql, blobs, store, fixtures } = yield* seedRepo({
            blobs: 30,
            blobSize: 2000,
            trees: 3,
          });
          const promotedFixtures: Array<Fixture> = [];
          for (let i = 0; i < 12; i++)
            promotedFixtures.push(yield* makeFixture(3, bytes(2000, i + 500)));
          const packId = wirePackId("01RECEIVE00000000000000001");
          // The wire object carries junk around the referenced spans (a real
          // one carries trees, commits and delta entries): only spans move.
          const { bytes: wire, offsets } = layout(promotedFixtures, 333);
          const withJunk = concat([wire, bytes(5000, 9)]);
          yield* blobs.put(packKeyOf(REPO, packId), withJunk);
          yield* store.insertStagedBatch(
            "push-Q",
            promotedFixtures.map((f) => ({
              oid: f.oid,
              type: f.type,
              size: f.content.length,
              zdata: f.zdata,
              pack: { packId, offset: offsets.get(f.oid)! },
            })),
          );
          yield* sql.run(`UPDATE objects SET staged_push = NULL`);
          const p1 = yield* runCompactJob({
            repoId: REPO,
            sql,
            blobs,
            maxObjects: 15,
            maxBytes: 1 << 30,
          });
          const p2 = yield* runCompactJob({
            repoId: REPO,
            sql,
            blobs,
            maxObjects: 15,
            maxBytes: 1 << 30,
          });
          expect(p1.moved + p2.moved).toBe(30);
          const merge = yield* runGeometricMergeJob({
            repoId: REPO,
            sql,
            blobs,
          });
          expect(merge.packs).toBe(3);
          expect(merge.pendingDelete).toContain(packKeyOf(REPO, packId));
          const packs = yield* sql.all<{ pack_id: string; n: number }>(
            `SELECT pack_id, COUNT(*) AS n FROM objects WHERE location = 'pack' GROUP BY pack_id`,
          );
          expect(packs).toEqual([{ pack_id: merge.packId, n: 42 }]);
          // The merged pack is a clean packfile the parser accepts, and every
          // object — promoted ones included — reads back through it.
          const merged = blobs.objects.get(packKey(REPO, merge.packId!))!;
          expect(verifyPack(merged)).toEqual({ objects: 42 });
          const all = yield* store.readContentBatch(
            [...fixtures, ...promotedFixtures].map((f) => f.oid),
          );
          expect(all.size).toBe(45);
          for (const f of promotedFixtures)
            expect(Array.from(all.get(f.oid)!)).toEqual(Array.from(f.content));
        }),
      );
    });
  },
);

describe("prepared object view", { tags: ["unit", "local"] }, () => {
  test("reads only its own staged objects and live objects, with a size cap", () =>
    run(
      Effect.gen(function* () {
        const sql = makeTestSqlClient();
        const store = makeObjectStore({
          sql,
          blobs: makeMemoryBlobStore(),
          repoId: REPO,
        });
        const own = yield* makeFixture(3, new TextEncoder().encode("own"));
        const other = yield* makeFixture(3, new TextEncoder().encode("other"));
        yield* store.insertStaged("mine", { ...own, size: own.content.length });
        yield* store.insertStaged("theirs", {
          ...other,
          size: other.content.length,
        });
        expect(yield* store.getMeta(own.oid)).toBeUndefined();
        expect(
          (yield* store.readPrepared("mine", own.oid, 3))?.content,
        ).toEqual(own.content);
        expect(
          yield* store.readPrepared("mine", other.oid, 100),
        ).toBeUndefined();
        const tooBig = yield* Effect.result(
          store.readPrepared("mine", own.oid, 2),
        );
        expect(tooBig._tag).toBe("Failure");
      }),
    ));
});
