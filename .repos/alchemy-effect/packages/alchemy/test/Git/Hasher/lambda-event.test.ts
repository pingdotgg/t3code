import {
  boundScan,
  decodeHashResponse,
  encodeHashEvent,
  handleHashEvent,
  isHashEvent,
} from "@/Git/Hasher/index.ts";
import {
  encodeTypeSize,
  hashObject,
  makeSha1,
} from "@/Git/Protocol/ObjectCodec.ts";
import { packHeader } from "@/Git/Protocol/PackWriter.ts";
import { scanPart } from "@/Git/Protocol/PartialScan.ts";
import * as Zlib from "@/Git/Protocol/Zlib.ts";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import { concat } from "../harness/pack.ts";

const buildPack = (n: number) =>
  Effect.gen(function* () {
    const pieces: Array<Uint8Array> = [packHeader(n)];
    for (let i = 0; i < n; i++) {
      const c = new Uint8Array(300 + (i % 50));
      crypto.getRandomValues(c);
      yield* hashObject(3, c);
      pieces.push(encodeTypeSize(3, c.length), yield* Zlib.deflate(c));
    }
    const body = concat(pieces);
    const sha = makeSha1();
    sha.update(body);
    return concat([body, sha.digest()]);
  });

describe("Lambda hash event (DESIGN §22.11)", () => {
  test("a chunk round-trips through the event and response encodings", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const pack = yield* buildPack(40);
        const event = encodeHashEvent(pack, {
          base: 12,
          skip: 12,
          remaining: 40,
          maxObjectSize: 1 << 20,
        });
        expect(isHashEvent(event)).toBe(true);
        expect(isHashEvent({ payload: 1 })).toBe(false);
        const response = yield* handleHashEvent(event);
        const scan = yield* decodeHashResponse(response);
        const direct = yield* scanPart(pack.subarray(12), {
          base: 12,
          remaining: 40,
          maxObjectSize: 1 << 20,
        });
        expect(scan.count).toBe(direct.count);
        expect(scan.entries.map((e) => e.oid)).toEqual(
          direct.entries.map((e) => e.oid),
        );
        expect(scan.consumedTo).toBe(direct.consumedTo);
      }),
    );
  });

  test("boundScan demotes the largest resolved deltas until the budget fits and keeps their bases", () => {
    const mk = (i: number, z: number) => ({
      oid: `${i}`.padStart(40, "a") as never,
      type: 3 as const,
      offset: i * 100,
      size: z * 2,
      dataOffset: i * 100 + 2,
      span: 10,
      zdata: new Uint8Array(z),
      baseOffset: i * 100 - 50,
    });
    const scan = {
      firstOffset: 12,
      entries: [mk(1, 5000), mk(2, 100), mk(3, 3000)],
      unresolved: [],
      consumedTo: 400,
      count: 3,
    };
    const bounded = boundScan(scan, 3000 + 3 * 120);
    // 5000 goes first (8100 → 3100, still over), then 3000; 100 fits.
    expect(bounded.entries.map((e) => e.offset)).toEqual([200]);
    expect(bounded.unresolved.map((u) => [u.offset, u.baseOffset])).toEqual([
      [100, 50],
      [300, 250],
    ]);
    // Under budget: content stripped, nothing demoted.
    const roomy = boundScan(scan, 1 << 20);
    expect(roomy.entries.length).toBe(3);
    expect(roomy.unresolved.length).toBe(0);
  });

  test("an error on the Lambda side is a typed HashError for the client", async () => {
    const result = await Effect.runPromise(
      Effect.result(decodeHashResponse({ error: "PackFormatError: bad" })),
    );
    expect(result._tag).toBe("Failure");
  });
});
