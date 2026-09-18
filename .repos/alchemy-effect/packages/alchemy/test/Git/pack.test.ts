/**
 * Tier-1 pack parse/write round-trip tests (DESIGN.md §9) against the
 * checked-in fixture packs in `test/fixtures/packs/` (generated once by the
 * real `git` CLI — see the README there; never regenerated at test time).
 *
 * Covers: header/count validation, no-delta ingestion with byte-verbatim
 * zdata (re-hash proof), OFS_DELTA and REF_DELTA resolution, thin-pack
 * resolution against a seeded object store (and the MissingDeltaBaseError
 * without it), trailer-checksum rejection, PackWriter → PackParser
 * round-trips, and `git index-pack --strict` as the oracle for writer output.
 */
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import {
  concatBytes,
  decodeOfsDeltaOffset,
  decodeTypeSize,
  hashObject,
  type ObjectType,
} from "@/Git/Protocol/ObjectCodec.ts";
import {
  bufferRandomAccess,
  ingestPack,
  readPackHeader,
  type ResolvedEntry,
  type ThinBaseSource,
} from "@/Git/Protocol/PackParser.ts";
import { writePackBytes } from "@/Git/Protocol/PackWriter.ts";
import type { ManifestEntry, ObjectSource } from "@/Git/Protocol/Store.ts";
import { inflate, inflateEntry } from "@/Git/Protocol/Zlib.ts";
import { makeStreamingSource } from "@/Git/Store/StreamingSource.ts";
import * as Fiber from "effect/Fiber";

// ── manifest shape (test/fixtures/packs/manifest.json) ──────────────────────

interface PackManifest {
  readonly commits: {
    readonly c1: string;
    readonly c2: string;
    readonly c3: string;
  };
  readonly tag: {
    readonly oid: string;
    readonly target: string;
    readonly name: string;
  };
  readonly tree1: string;
  readonly blobs: {
    readonly data1: string;
    readonly data2: string;
    readonly hello1: string;
  };
  readonly packs: Record<
    string,
    {
      readonly count: number;
      readonly oids: ReadonlyArray<string>;
      readonly thin?: boolean;
    }
  >;
}

const fixturesDir = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(import.meta.dirname, "fixtures", "packs");
});

const readFixture = Effect.fn(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fixturesDir;
  return yield* fs.readFile(path.join(dir, name));
});

const readManifest = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fixturesDir;
  const text = yield* fs.readFileString(path.join(dir, "manifest.json"));
  return yield* Effect.try(() => JSON.parse(text) as PackManifest);
});

// ── in-memory ObjectSource fed by the ingest sink ───────────────────────────

interface StoredObject {
  readonly type: ObjectType;
  readonly content: Uint8Array;
  readonly zdata: Uint8Array;
}

const makeMemoryStore = () => {
  const objects = new Map<string, StoredObject>();
  const source: ObjectSource & ThinBaseSource = {
    has: (oid) => Effect.sync(() => objects.has(oid)),
    filterExisting: (oids) =>
      Effect.sync(() => oids.filter((oid) => objects.has(oid))),
    getMeta: (oid) =>
      Effect.sync(() => {
        const stored = objects.get(oid);
        return stored === undefined
          ? undefined
          : {
              oid,
              type: stored.type,
              size: stored.content.length,
              zsize: stored.zdata.length,
              location: "row" as const,
            };
      }),
    readZData: (oid) =>
      Stream.fromEffect(Effect.sync(() => objects.get(oid)!.zdata)),
    readBase: (oid) =>
      Effect.sync(() => {
        const stored = objects.get(oid);
        return stored === undefined
          ? undefined
          : { type: stored.type, content: stored.content };
      }),
    readContent: (oid) => Effect.sync(() => objects.get(oid)!.content),
  };
  /** Ingest sink: stage the resolved entry (zdata is already a safe copy). */
  const sink = (entry: ResolvedEntry) =>
    Effect.gen(function* () {
      const content = yield* inflate(entry.zdata);
      objects.set(entry.oid, { type: entry.type, content, zdata: entry.zdata });
    });
  const manifestEntries = (): ReadonlyArray<ManifestEntry> =>
    Array.from(objects.entries(), ([oid, stored]) => ({
      oid,
      type: stored.type,
      size: stored.content.length,
      zsize: stored.zdata.length,
      location: "row" as const,
    }));
  return { objects, source, sink, manifestEntries };
};

const ingestInto = Effect.fn(function* (
  pack: Uint8Array,
  store: ReturnType<typeof makeMemoryStore>,
) {
  return yield* ingestPack({
    source: bufferRandomAccess(pack),
    store: store.source,
    sink: store.sink,
  });
});

/** Scan the raw entry types of a pack without resolving anything. */
const scanEntryTypes = Effect.fn(function* (pack: Uint8Array) {
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  const count = view.getUint32(8);
  const types: Array<number> = [];
  let offset = 12;
  for (let i = 0; i < count; i++) {
    const header = decodeTypeSize(pack, offset);
    offset = header.next;
    if (header.type === 6) offset = decodeOfsDeltaOffset(pack, offset).next;
    if (header.type === 7) offset += 20;
    const entry = yield* inflateEntry(pack, offset);
    offset += entry.bytesConsumed;
    types.push(header.type);
  }
  return types;
});

const sortedOids = (oids: ReadonlyArray<string>) => [...oids].sort();

const platform = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, BunServices.BunServices>> =>
  Effect.provide(effect, BunServices.layer) as Effect.Effect<
    A,
    E,
    Exclude<R, BunServices.BunServices>
  >;

describe("fixture pack parsing", () => {
  it.live("empty pack: count 0, valid trailer, zero objects", () =>
    Effect.gen(function* () {
      const pack = yield* readFixture("empty.pack");
      const header = yield* readPackHeader(bufferRandomAccess(pack));
      expect(header.version).toBe(2);
      expect(header.count).toBe(0);
      const store = makeMemoryStore();
      const summary = yield* ingestInto(pack, store);
      expect(summary.count).toBe(0);
      expect(summary.oids).toEqual([]);
    }).pipe(platform),
  );

  it.live(
    "simple pack (window=0): no deltas, byte-verbatim zdata re-hashes to the manifest oids",
    () =>
      Effect.gen(function* () {
        const manifest = yield* readManifest;
        const pack = yield* readFixture("simple.pack");
        const types = yield* scanEntryTypes(pack);
        expect(types).not.toContain(6);
        expect(types).not.toContain(7);

        const store = makeMemoryStore();
        const summary = yield* ingestInto(pack, store);
        expect(sortedOids(summary.oids)).toEqual(
          sortedOids(manifest.packs["simple"]!.oids),
        );
        // the ingest stores the pack's compressed span verbatim; re-hashing the
        // inflated content must reproduce every oid
        for (const [oid, stored] of store.objects) {
          expect(yield* hashObject(stored.type, stored.content)).toBe(oid);
        }
        // the notable objects landed with the right kinds
        expect(store.objects.get(manifest.commits.c1)?.type).toBe(1);
        expect(store.objects.get(manifest.tree1)?.type).toBe(2);
        expect(store.objects.get(manifest.blobs.data1)?.type).toBe(3);
        expect(store.objects.get(manifest.tag.oid)?.type).toBe(4);
      }).pipe(platform),
  );

  it.live(
    "streaming: delta bases evicted before the body ends are deferred and resolved through the fallback (DESIGN §22.6)",
    () =>
      Effect.gen(function* () {
        const manifest = yield* readManifest;
        const pack = yield* readFixture("ofs-delta.pack");
        // Retain almost nothing, so every base is evicted before its
        // delta arrives; a parser that blocked on evicted bytes would
        // deadlock against backpressure here.
        const feeder = makeStreamingSource({
          slabBytes: 256,
          retainBytes: 512,
          backpressureBytes: 1024,
        });
        const store = makeMemoryStore();
        const parse = yield* Effect.forkChild(
          ingestPack({
            source: feeder.source,
            store: store.source,
            sink: store.sink,
          }),
        );
        for (let at = 0; at < pack.length; at += 300) {
          yield* feeder.push(
            pack.subarray(at, Math.min(at + 300, pack.length)),
          );
        }
        feeder.setFallback(bufferRandomAccess(pack));
        feeder.end();
        const summary = yield* Fiber.join(parse);
        expect(sortedOids(summary.oids)).toEqual(
          sortedOids(manifest.packs["ofs-delta"]!.oids),
        );
      }).pipe(platform),
  );

  it.live(
    "ofs-delta pack: OFS_DELTA entries resolve to the same object set",
    () =>
      Effect.gen(function* () {
        const manifest = yield* readManifest;
        const pack = yield* readFixture("ofs-delta.pack");
        const types = yield* scanEntryTypes(pack);
        expect(types).toContain(6);

        const store = makeMemoryStore();
        const resolvedFromDelta: Array<string> = [];
        const summary = yield* ingestPack({
          source: bufferRandomAccess(pack),
          store: store.source,
          sink: (entry) =>
            Effect.gen(function* () {
              if (entry.fromDelta) resolvedFromDelta.push(entry.oid);
              yield* store.sink(entry);
            }),
        });
        expect(sortedOids(summary.oids)).toEqual(
          sortedOids(manifest.packs["ofs-delta"]!.oids),
        );
        expect(resolvedFromDelta.length).toBeGreaterThan(0);
        for (const [oid, stored] of store.objects) {
          expect(yield* hashObject(stored.type, stored.content)).toBe(oid);
        }
      }).pipe(platform),
  );

  it.live(
    "ref-delta pack: REF_DELTA entries resolve to the same object set",
    () =>
      Effect.gen(function* () {
        const manifest = yield* readManifest;
        const pack = yield* readFixture("ref-delta.pack");
        const types = yield* scanEntryTypes(pack);
        expect(types).toContain(7);

        const store = makeMemoryStore();
        const summary = yield* ingestInto(pack, store);
        expect(sortedOids(summary.oids)).toEqual(
          sortedOids(manifest.packs["ref-delta"]!.oids),
        );
      }).pipe(platform),
  );

  it.live("thin pack: resolves REF_DELTA bases from the seeded store", () =>
    Effect.gen(function* () {
      const manifest = yield* readManifest;
      const store = makeMemoryStore();
      // seed with c1's closure (base.pack), then ingest the thin pack
      yield* ingestInto(yield* readFixture("base.pack"), store);
      const thin = yield* readFixture("thin.pack");
      const types = yield* scanEntryTypes(thin);
      expect(types).toContain(7);
      const summary = yield* ingestInto(thin, store);
      expect(sortedOids(summary.oids)).toEqual(
        sortedOids(manifest.packs["thin"]!.oids),
      );
      // the extended blob resolved against the excluded base blob
      expect(summary.oids).toContain(manifest.blobs.data2);
      const data2 = store.objects.get(manifest.blobs.data2)!;
      expect(yield* hashObject(data2.type, data2.content)).toBe(
        manifest.blobs.data2,
      );
    }).pipe(platform),
  );

  it.live("thin pack without its bases fails with MissingDeltaBaseError", () =>
    Effect.gen(function* () {
      const thin = yield* readFixture("thin.pack");
      const empty = makeMemoryStore();
      const result = yield* Effect.result(ingestInto(thin, empty));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("MissingDeltaBaseError");
      }
    }).pipe(platform),
  );

  it.live("corrupted trailer is rejected with PackChecksumMismatch", () =>
    Effect.gen(function* () {
      const pack = Uint8Array.from(yield* readFixture("simple.pack"));
      pack[pack.length - 1]! ^= 0xff;
      const result = yield* Effect.result(ingestInto(pack, makeMemoryStore()));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("PackChecksumMismatch");
      }
    }).pipe(platform),
  );
});

describe("PackWriter round-trips", () => {
  it.live(
    "rewrite of an ingested delta pack re-parses to an identical object set",
    () =>
      Effect.gen(function* () {
        const manifest = yield* readManifest;
        const store = makeMemoryStore();
        yield* ingestInto(yield* readFixture("ofs-delta.pack"), store);

        const rewritten = concatBytes(
          yield* Stream.runCollect(
            writePackBytes(store.manifestEntries(), store.source),
          ),
        );
        const header = yield* readPackHeader(bufferRandomAccess(rewritten));
        expect(header.version).toBe(2);
        expect(header.count).toBe(manifest.packs["ofs-delta"]!.count);

        const reparsed = makeMemoryStore();
        const summary = yield* ingestInto(rewritten, reparsed);
        expect(sortedOids(summary.oids)).toEqual(
          sortedOids(manifest.packs["ofs-delta"]!.oids),
        );
        for (const [oid, stored] of reparsed.objects) {
          expect(yield* hashObject(stored.type, stored.content)).toBe(oid);
        }
      }).pipe(platform),
  );

  it.live(
    "writer output is accepted by git index-pack --strict",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = makeMemoryStore();
        yield* ingestInto(yield* readFixture("simple.pack"), store);
        const rewritten = concatBytes(
          yield* Stream.runCollect(
            writePackBytes(store.manifestEntries(), store.source),
          ),
        );
        const dir = yield* fs.makeTempDirectory({
          prefix: "git-service-pack-",
        });
        const packPath = path.join(dir, "writer-output.pack");
        yield* fs.writeFile(packPath, rewritten);

        const handle = yield* ChildProcess.make(
          "git",
          ["index-pack", "--strict", packPath],
          { cwd: dir, extendEnv: true },
        );
        const [exitCode, stderr] = yield* Effect.all(
          [handle.exitCode, Stream.mkString(Stream.decodeText(handle.stderr))],
          { concurrency: 2 },
        );
        expect(`${exitCode}:${stderr}`).toBe(`0:${stderr}`);
        expect(exitCode).toBe(0);
      }).pipe(platform, Effect.timeout("30 seconds")),
    { timeout: 60_000 },
  );
});
