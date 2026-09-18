/**
 * Tier-1 pure codec tests (DESIGN.md §9): pkt-line framing, pack varints
 * (including the OFS_DELTA +1-bias multibyte offsets), delta application
 * (including the `size==0 ⇒ 0x10000` copy special case), tree sort rules,
 * object hashing against real-git-computed oids, and zlib entry-boundary
 * accounting over concatenated deflate streams.
 *
 * No cloud, no deploy — everything runs in-process in milliseconds.
 */
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { applyDelta, readDeltaHeader } from "@/Git/Protocol/Delta.ts";
import {
  bytesToHex,
  concatBytes,
  decodeOfsDeltaOffset,
  decodeSizeVarint,
  decodeTypeSize,
  encodeCommit,
  encodeOfsDeltaOffset,
  encodeSizeVarint,
  encodeTree,
  encodeTypeSize,
  formatIdentity,
  hashObject,
  hexToBytes,
  ObjectType,
  parseCommit,
  parseTree,
  treeEntryCompare,
  utf8Decode,
  utf8Encode,
} from "@/Git/Protocol/ObjectCodec.ts";
import {
  decodePktLines,
  decodePktStream,
  errPkt,
  flushPkt,
  MAX_PKT_PAYLOAD,
  pktLine,
  pktPayloadText,
  pktText,
  readPktLineAt,
} from "@/Git/Protocol/Pkt.ts";
import { SIDEBAND_DATA_MAX, sidebandFrames } from "@/Git/Protocol/Sideband.ts";
import { deflate, inflate, inflateEntry } from "@/Git/Protocol/Zlib.ts";

describe("pkt-line", () => {
  it.live("encodes data, text (LF-appended), flush, and ERR pkts", () =>
    Effect.gen(function* () {
      expect(utf8Decode(pktText("done"))).toBe("0009done\n");
      // pktText must not double-append the LF
      expect(utf8Decode(pktText("done\n"))).toBe("0009done\n");
      expect(utf8Decode(flushPkt)).toBe("0000");
      expect(utf8Decode(errPkt("boom"))).toBe("000dERR boom\n");
      const data = pktLine(utf8Encode("abc"));
      expect(utf8Decode(data)).toBe("0007abc");
    }),
  );

  it.live(
    "round-trips a mixed body and strips trailing LF in payload text",
    () =>
      Effect.gen(function* () {
        const body = concatBytes([
          pktText(
            "want 0000000000000000000000000000000000000001 side-band-64k",
          ),
          flushPkt,
          pktText("done"),
        ]);
        const pkts = yield* decodePktLines(body);
        expect(pkts.length).toBe(3);
        expect(pkts[0]!._tag).toBe("data");
        expect(pkts[1]!._tag).toBe("flush");
        expect(pkts[2]!._tag).toBe("data");
        const first = pkts[0]!;
        if (first._tag === "data") {
          expect(pktPayloadText(first.payload)).toBe(
            "want 0000000000000000000000000000000000000001 side-band-64k",
          );
        }
      }),
  );

  it.live("stream decoder survives pathological 1-byte chunking", () =>
    Effect.gen(function* () {
      const body = concatBytes([
        pktText("hello"),
        flushPkt,
        pktLine(utf8Encode("raw")),
      ]);
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < body.length; i++) {
        chunks.push(body.subarray(i, i + 1));
      }
      const pkts = yield* Stream.runCollect(
        decodePktStream(Stream.fromArray(chunks)),
      );
      expect(pkts.length).toBe(3);
    }),
  );

  it.live("readPktLineAt reports incomplete and invalid frames", () =>
    Effect.gen(function* () {
      // a declared 8-byte pkt with only 6 bytes present
      const partial = utf8Encode("0008ab");
      expect(readPktLineAt(partial, 0)._tag).toBe("incomplete");
      // non-hex length prefix
      expect(readPktLineAt(utf8Encode("zzzzabcd"), 0)._tag).toBe("invalid");
      // lengths 1-3 are reserved/invalid
      expect(readPktLineAt(utf8Encode("0003x"), 0)._tag).toBe("invalid");
    }),
  );

  it.live("rejects payloads over the 65516-byte cap", () =>
    Effect.gen(function* () {
      const max = new Uint8Array(MAX_PKT_PAYLOAD);
      expect(pktLine(max).length).toBe(4 + MAX_PKT_PAYLOAD);
      expect(() => pktLine(new Uint8Array(MAX_PKT_PAYLOAD + 1))).toThrow();
    }),
  );
});

describe("sideband framing", () => {
  it.live("splits payloads at the 65515-byte data cap with the band byte", () =>
    Effect.gen(function* () {
      const big = new Uint8Array(SIDEBAND_DATA_MAX + 10).fill(7);
      const frames = sidebandFrames(1, big);
      expect(frames.length).toBe(2);
      expect(frames[0]!.length).toBe(4 + 1 + SIDEBAND_DATA_MAX);
      expect(frames[1]!.length).toBe(4 + 1 + 10);
      expect(frames[0]![4]).toBe(1);
      expect(frames[1]![4]).toBe(1);
    }),
  );
});

describe("pack varints", () => {
  it.live(
    "type/size header round-trips across the continuation boundaries",
    () =>
      Effect.gen(function* () {
        for (const size of [
          0,
          15,
          16,
          127,
          128,
          4095,
          4096,
          1 << 20,
          2 ** 32 + 5,
        ]) {
          for (const type of [1, 2, 3, 4, 6, 7] as const) {
            const enc = encodeTypeSize(type, size);
            const dec = decodeTypeSize(enc, 0);
            expect(dec.type).toBe(type);
            expect(dec.size).toBe(size);
            expect(dec.next).toBe(enc.length);
          }
        }
        // 4-bit sizes fit in one byte; 5 bits force a continuation
        expect(encodeTypeSize(ObjectType.blob, 15).length).toBe(1);
        expect(encodeTypeSize(ObjectType.blob, 16).length).toBe(2);
      }),
  );

  it.live("delta-payload size varint round-trips", () =>
    Effect.gen(function* () {
      for (const v of [0, 1, 127, 128, 16383, 16384, 2 ** 31]) {
        const enc = encodeSizeVarint(v);
        const dec = decodeSizeVarint(enc, 0);
        expect(dec.value).toBe(v);
        expect(dec.next).toBe(enc.length);
      }
    }),
  );

  it.live("OFS_DELTA offsets carry the +1 bias per continuation byte", () =>
    Effect.gen(function* () {
      // The classic bug: without the bias, [0x80, 0x00] would decode as 0.
      // With it, two-byte encodings cover exactly 128..16511 (128 + 2^14 - 1).
      expect(encodeOfsDeltaOffset(127).length).toBe(1);
      expect(encodeOfsDeltaOffset(128).length).toBe(2);
      expect(Array.from(encodeOfsDeltaOffset(128))).toEqual([0x80, 0x00]);
      expect(encodeOfsDeltaOffset(16511).length).toBe(2);
      expect(encodeOfsDeltaOffset(16512).length).toBe(3);
      for (const v of [
        1,
        127,
        128,
        129,
        255,
        256,
        16383,
        16384,
        16511,
        16512,
        2 ** 24,
      ]) {
        const enc = encodeOfsDeltaOffset(v);
        const dec = decodeOfsDeltaOffset(enc, 0);
        expect(dec.value).toBe(v);
        expect(dec.next).toBe(enc.length);
      }
      // known decode vectors
      expect(decodeOfsDeltaOffset(Uint8Array.from([0x80, 0x00]), 0).value).toBe(
        128,
      );
      expect(decodeOfsDeltaOffset(Uint8Array.from([0x81, 0x00]), 0).value).toBe(
        256,
      );
    }),
  );
});

describe("delta application", () => {
  it.live("applies copy + insert instruction streams", () =>
    Effect.gen(function* () {
      const base = utf8Encode("the quick brown fox jumps over the lazy dog");
      const delta = concatBytes([
        encodeSizeVarint(base.length),
        encodeSizeVarint(16 + 5 + 18),
        Uint8Array.from([0b10010001, 4, 16]), // copy offset=4 size=16
        Uint8Array.from([5]), // insert 5 bytes
        utf8Encode("leaps"),
        Uint8Array.from([0b10010001, 25, 18]), // copy offset=25 size=18
      ]);
      const header = readDeltaHeader(delta);
      expect(header.baseSize).toBe(base.length);
      expect(header.resultSize).toBe(39);
      const out = yield* applyDelta(base, delta);
      expect(utf8Decode(out)).toBe("quick brown fox leaps over the lazy dog");
    }),
  );

  it.live("copy size 0 means 0x10000 bytes", () =>
    Effect.gen(function* () {
      const base = new Uint8Array(0x10000 + 10);
      for (let i = 0; i < base.length; i++) base[i] = i % 251;
      const delta = concatBytes([
        encodeSizeVarint(base.length),
        encodeSizeVarint(0x10000),
        // copy bit set, no offset bytes, no size bytes ⇒ offset 0, size 0x10000
        Uint8Array.from([0b10000000]),
      ]);
      const out = yield* applyDelta(base, delta);
      expect(out.length).toBe(0x10000);
      expect(out[0]).toBe(base[0]);
      expect(out[0xffff]).toBe(base[0xffff]);
    }),
  );

  it.live("rejects a result-size mismatch as DeltaFormatError", () =>
    Effect.gen(function* () {
      const base = utf8Encode("0123456789");
      const delta = concatBytes([
        encodeSizeVarint(base.length),
        encodeSizeVarint(99), // declared result size never produced
        Uint8Array.from([0b10010001, 0, 4]), // copy 4 bytes
      ]);
      const result = yield* Effect.result(applyDelta(base, delta));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("DeltaFormatError");
      }
    }),
  );
});

describe("tree codec", () => {
  it.live("sorts directories as name + '/' (the fsck rule)", () =>
    Effect.gen(function* () {
      const entries = [
        { mode: "100644", name: "foo.txt", oid: "a".repeat(40) },
        { mode: "40000", name: "foo", oid: "b".repeat(40) },
        { mode: "100644", name: "foo", oid: "c".repeat(40) },
      ];
      const sorted = [...entries].sort(treeEntryCompare);
      // blob "foo" < blob "foo.txt" < tree "foo" (compares as "foo/")
      expect(sorted[0]!.oid).toBe("c".repeat(40));
      expect(sorted[1]!.name).toBe("foo.txt");
      expect(sorted[2]!.mode).toBe("40000");
    }),
  );

  it.live("encode → parse round-trips and normalizes entry order", () =>
    Effect.gen(function* () {
      const entries = [
        { mode: "100644", name: "zebra", oid: "a".repeat(40) },
        { mode: "40000", name: "dir", oid: "b".repeat(40) },
        { mode: "100755", name: "run.sh", oid: "c".repeat(40) },
      ];
      const encoded = yield* encodeTree(entries);
      const parsed = yield* parseTree(encoded);
      expect(parsed.length).toBe(3);
      expect(parsed.map((e) => e.name)).toEqual(["dir", "run.sh", "zebra"]);
      expect(parsed[0]!.mode).toBe("40000");
    }),
  );
});

describe("object hashing (real-git oracle oids)", () => {
  it.live("hashes blobs to the oids git computes", () =>
    Effect.gen(function* () {
      // git hash-object oracle values
      expect(yield* hashObject(ObjectType.blob, utf8Encode("hello\n"))).toBe(
        "ce013625030ba8dba906f756967f9e9ca394464a",
      );
      expect(
        yield* hashObject(ObjectType.blob, utf8Encode("hello world\n")),
      ).toBe("3b18e512dba79e4c8300dd08aeb37f8e728b8dad");
      // the famous empty blob / empty tree constants
      expect(yield* hashObject(ObjectType.blob, new Uint8Array(0))).toBe(
        "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
      );
      expect(yield* hashObject(ObjectType.tree, new Uint8Array(0))).toBe(
        "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      );
    }),
  );

  it.live("hex codecs round-trip", () =>
    Effect.gen(function* () {
      const hex = "9e0b5a0bd293f9feda554193a204193a2c3c5d9c";
      expect(bytesToHex(hexToBytes(hex))).toBe(hex);
    }),
  );
});

describe("commit parsing", () => {
  it.live("parses tree/parents/identities/message", () =>
    Effect.gen(function* () {
      const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
      const parent = "ce013625030ba8dba906f756967f9e9ca394464a";
      const commit = utf8Encode(
        `tree ${tree}\n` +
          `parent ${parent}\n` +
          `author A U Thor <author@example.com> 1700000000 +0130\n` +
          `committer C O Mitter <committer@example.com> 1700000100 -0500\n` +
          `\n` +
          `subject line\n\nbody\n`,
      );
      const parsed = yield* parseCommit(commit);
      expect(parsed.tree).toBe(tree);
      expect(parsed.parents).toEqual([parent]);
      expect(parsed.author.email).toBe("author@example.com");
      expect(parsed.author.when).toBe(1700000000);
      expect(parsed.author.tz).toBe("+0130");
      expect(parsed.committer.tz).toBe("-0500");
      expect(parsed.message).toBe("subject line\n\nbody\n");
    }),
  );

  it.live("preserves gpgsig continuation lines", () =>
    Effect.gen(function* () {
      const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
      const commit = utf8Encode(
        `tree ${tree}\n` +
          `author A <a@b.c> 1 +0000\n` +
          `committer A <a@b.c> 1 +0000\n` +
          `gpgsig -----BEGIN PGP SIGNATURE-----\n` +
          ` line2\n` +
          ` -----END PGP SIGNATURE-----\n` +
          `\n` +
          `msg\n`,
      );
      const parsed = yield* parseCommit(commit);
      expect(parsed.gpgsig).toContain("line2");
      expect(parsed.gpgsig).toContain("-----END PGP SIGNATURE-----");
    }),
  );
});

describe("commit encoding", () => {
  // A real git-produced commit (git 2.x, `git commit -m`), checked in as a
  // fixture: the oid is git's own, so a matching hash proves the bytes are
  // byte-exact.
  const FIXTURE_OID = "805ee86374143354d5a6e5e4df894aa1d631fbb1";
  const FIXTURE_COMMIT =
    "tree 44caf5de156e5707051d55989b7db370a80af206\n" +
    "parent a684c642abd0ef33ec672ce701f48f824837cd03\n" +
    "author A U Thor <author@example.com> 1700000200 +0000\n" +
    "committer A U Thor <author@example.com> 1700000300 +0000\n" +
    "\n" +
    "second commit\n" +
    "\n" +
    "with a body line\n";

  it.live("round-trips a real git commit byte-exactly (fixture oid)", () =>
    Effect.gen(function* () {
      const bytes = utf8Encode(FIXTURE_COMMIT);
      // the fixture really is the commit git hashed
      expect(yield* hashObject(ObjectType.commit, bytes)).toBe(FIXTURE_OID);
      const parsed = yield* parseCommit(bytes);
      const encoded = yield* encodeCommit({
        tree: parsed.tree,
        parents: parsed.parents,
        author: parsed.author,
        committer: parsed.committer,
        message: parsed.message,
      });
      expect(utf8Decode(encoded)).toBe(FIXTURE_COMMIT);
      expect(yield* hashObject(ObjectType.commit, encoded)).toBe(FIXTURE_OID);
    }),
  );

  it.live("encodes multi-parent commits and formats identities", () =>
    Effect.gen(function* () {
      const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
      const p1 = "ce013625030ba8dba906f756967f9e9ca394464a";
      const p2 = "3b18e512dba79e4c8300dd08aeb37f8e728b8dad";
      const identity = {
        name: "git-service",
        email: "git-service@localhost",
        when: 1700000000,
        tz: "+0000",
      };
      expect(formatIdentity(identity)).toBe(
        "git-service <git-service@localhost> 1700000000 +0000",
      );
      const encoded = yield* encodeCommit({
        tree,
        parents: [p1, p2],
        author: identity,
        committer: identity,
        message: "Merge pull request #1 from feature\n",
      });
      const parsed = yield* parseCommit(encoded);
      expect(parsed.tree).toBe(tree);
      expect(parsed.parents).toEqual([p1, p2]);
      expect(parsed.author).toEqual(identity);
      expect(parsed.message).toBe("Merge pull request #1 from feature\n");
    }),
  );

  it.live("rejects malformed oids and identities", () =>
    Effect.gen(function* () {
      const tree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
      const identity = {
        name: "ok",
        email: "ok@example.com",
        when: 1,
        tz: "+0000",
      };
      const badTree = yield* Effect.result(
        encodeCommit({
          tree: "nope",
          parents: [],
          author: identity,
          committer: identity,
          message: "m\n",
        }),
      );
      expect(Result.isFailure(badTree)).toBe(true);
      const badName = yield* Effect.result(
        encodeCommit({
          tree,
          parents: [],
          author: { ...identity, name: "evil <injector>" },
          committer: identity,
          message: "m\n",
        }),
      );
      expect(Result.isFailure(badName)).toBe(true);
      const badTz = yield* Effect.result(
        encodeCommit({
          tree,
          parents: [],
          author: { ...identity, tz: "UTC" },
          committer: identity,
          message: "m\n",
        }),
      );
      expect(Result.isFailure(badTz)).toBe(true);
    }),
  );
});

describe("zlib boundary accounting", () => {
  it.live("inflateEntry reports the exact compressed span of each entry", () =>
    Effect.gen(function* () {
      const a = yield* deflate(utf8Encode("first object content"));
      const b = yield* deflate(utf8Encode("second object content"));
      const buf = concatBytes([a, b]);
      const first = yield* inflateEntry(buf, 0);
      expect(first.bytesConsumed).toBe(a.length);
      expect(utf8Decode(first.content)).toBe("first object content");
      const second = yield* inflateEntry(buf, first.bytesConsumed);
      expect(second.bytesConsumed).toBe(b.length);
      expect(utf8Decode(second.content)).toBe("second object content");
    }),
  );

  it.live("tolerates trailing junk after Z_STREAM_END", () =>
    Effect.gen(function* () {
      const z = yield* deflate(utf8Encode("payload"));
      const buf = concatBytes([z, utf8Encode("TRAILING GARBAGE")]);
      const entry = yield* inflateEntry(buf, 0);
      expect(entry.bytesConsumed).toBe(z.length);
      expect(utf8Decode(entry.content)).toBe("payload");
    }),
  );

  it.live("strict inflate round-trips deflate output", () =>
    Effect.gen(function* () {
      const content = utf8Encode("round trip me ".repeat(1000));
      const z = yield* deflate(content);
      expect(z.length).toBeLessThan(content.length);
      const back = yield* inflate(z);
      expect(utf8Decode(back)).toBe(utf8Decode(content));
    }),
  );

  it.live("strict inflate fails on a truncated stream", () =>
    Effect.gen(function* () {
      const z = yield* deflate(utf8Encode("payload to truncate"));
      const result = yield* Effect.result(inflate(z.subarray(0, z.length - 3)));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("ZlibError");
      }
    }),
  );
});
