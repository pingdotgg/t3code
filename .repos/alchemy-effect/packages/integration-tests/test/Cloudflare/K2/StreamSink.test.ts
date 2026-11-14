import {
  decodeWithSchema,
  encodeRecords,
  fromBase64,
  fromConsumedRecords,
  toBase64,
  toProduceRecords,
  wireSize,
} from "@alchemy.run/cloudflare/K2/K2Codec";
import type { EncodedRecord } from "@alchemy.run/cloudflare/K2/K2Types";
import {
  makeStreamSink,
  MAX_REQUEST_BYTES,
  packStreamSinkBatches,
} from "@alchemy.run/cloudflare/K2/StreamSinkBatch";
import type { WriteStreamClient } from "@alchemy.run/cloudflare/K2/WriteStream";
import {
  type K2StreamBinding,
  sendViaBinding,
} from "@alchemy.run/cloudflare/K2/WriteStreamBinding";
import { makeWriteStreamClient } from "@alchemy.run/cloudflare/K2/WriteStreamClient";
import { describe, expect, it } from "@alchemy.run/test";
import * as k2 from "@distilled.cloud/cloudflare/k2";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

/**
 * Pure tests of K2 record encoding, `StreamSink` packing and retries, and
 * the native binding's error mapping. Live delivery is covered by
 * `WriteStream.test.ts` and `ReadSubscription.test.ts`.
 */

const Order = Schema.Struct({ id: Schema.Number });

const record = (bytes: number): EncodedRecord => ({ content: new Uint8Array(bytes) });

const fakeClient = (failures: ReadonlyArray<k2.ProduceError["_tag"]> = []) => {
  const sent: EncodedRecord[][] = [];
  let attempt = 0;
  const client: WriteStreamClient<{ id: number }> = makeWriteStreamClient(Order, (records) =>
    Effect.suspend((): Effect.Effect<void, k2.K2Unavailable | k2.K2AppendOutcomeUnknown> => {
      const tag = failures[attempt++];
      if (tag === "K2Unavailable") {
        return Effect.fail(new k2.K2Unavailable({ code: 10211, message: "unavailable" }));
      }
      if (tag === "K2AppendOutcomeUnknown") {
        return Effect.fail(new k2.K2AppendOutcomeUnknown({ code: 10212, message: "maybe stored" }));
      }
      sent.push([...records]);
      return Effect.void;
    }),
  );
  return { client, sent, attempts: () => attempt };
};

const run = <A>(stream: Stream.Stream<A>, client: WriteStreamClient<A>) =>
  stream.pipe(
    Stream.run(makeStreamSink(client)),
    Effect.provideService(RuntimeContext, {} as never),
  );

describe("Cloudflare K2 records and StreamSink", { tags: ["unit", "local"] }, () => {
  it("round-trips bytes through standard base64", () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => i % 256);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    expect(toBase64(new TextEncoder().encode("hi?"))).toEqual("aGk/");
  });

  it("encodes strings as UTF-8 and drops empty headers", () => {
    const [a, b] = encodeRecords([
      { content: "é", headers: {} },
      { content: new ArrayBuffer(2), headers: { k: "v" } },
    ]);
    expect(a!.content).toEqual(new Uint8Array([0xc3, 0xa9]));
    expect(a!.headers).toBeUndefined();
    expect(b!.content.byteLength).toEqual(2);
    expect(toProduceRecords([b!])).toEqual([{ content: "AAA=", headers: { k: "v" } }]);
  });

  it.effect("decodes consumed JSON records with a schema", () =>
    Effect.gen(function* () {
      const consumed = fromConsumedRecords([
        { timestampMs: 1000, content: toBase64(new TextEncoder().encode('{"id":7}')) },
      ]);
      expect(consumed[0]!.timestamp.getTime()).toEqual(1000);
      expect(consumed[0]!.headers).toEqual({});
      const [decoded] = yield* decodeWithSchema(Order)(consumed);
      expect(decoded!.value).toEqual({ id: 7 });

      const bad = fromConsumedRecords([
        { timestampMs: 0, content: toBase64(new TextEncoder().encode("not json")) },
      ]);
      const error = yield* decodeWithSchema(Order)(bad).pipe(Effect.flip);
      expect(error._tag).toEqual("K2SchemaError");
    }),
  );

  it("packs requests under 5 MB of wire size, preserving order", () => {
    const records = Array.from({ length: 12 }, () => record(1_000_000));
    const batches = packStreamSinkBatches(records);
    expect(batches.map((b) => b.length)).toEqual([3, 3, 3, 3]);
    for (const batch of batches) {
      expect(batch.reduce((sum, r) => sum + wireSize(r), 0)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    }
    expect(batches.flat()).toEqual(records);
  });

  it("ships an oversized record alone", () => {
    const huge = record(MAX_REQUEST_BYTES);
    expect(packStreamSinkBatches([record(1), huge, record(1)]).map((b) => b.length)).toEqual([
      1, 1, 1,
    ]);
  });

  it.effect("sends one request per chunk with JSON headers", () =>
    Effect.gen(function* () {
      const { client, sent } = fakeClient();
      yield* run(
        Stream.fromIterable([1, 2, 3, 4, 5].map((id) => ({ id }))).pipe(Stream.rechunk(2)),
        client,
      );
      expect(sent.map((b) => b.length)).toEqual([2, 2, 1]);
      expect(sent[0]![0]!.headers).toEqual({ "content-type": "application/json" });
      expect(new TextDecoder().decode(sent[2]![0]!.content)).toEqual('{"id":5}');
    }),
  );

  // `it.live`: the retry schedule sleeps on the real clock.
  it.live("retries K2Unavailable (not stored) a bounded number of times", () =>
    Effect.gen(function* () {
      const { client, sent, attempts } = fakeClient(["K2Unavailable", "K2Unavailable"]);
      yield* run(Stream.make({ id: 1 }), client);
      expect(attempts()).toEqual(3);
      expect(sent.length).toEqual(1);
    }),
  );

  it.effect("never retries K2AppendOutcomeUnknown (may have been stored)", () =>
    Effect.gen(function* () {
      const { client, attempts } = fakeClient(["K2AppendOutcomeUnknown"]);
      const error = yield* run(Stream.make({ id: 1 }), client).pipe(Effect.flip);
      expect(error._tag).toEqual("K2AppendOutcomeUnknown");
      expect(attempts()).toEqual(1);
    }),
  );

  it.effect("maps native binding results onto the HTTP API's typed tags", () =>
    Effect.gen(function* () {
      const binding = (
        result: Awaited<ReturnType<K2StreamBinding["send"]>> | Error,
      ): K2StreamBinding => ({
        send: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)),
      });
      const records = [{ content: new Uint8Array([1]) }];
      yield* sendViaBinding(binding({ success: true }), records);

      const failure = (code: number) =>
        sendViaBinding(
          binding({ success: false, error: { code, message: "nope", retryable: false } }),
          records,
        ).pipe(
          Effect.flip,
          Effect.map((e) => e._tag),
        );
      expect(yield* failure(10200)).toEqual("K2StreamNotFound");
      expect(yield* failure(10204)).toEqual("K2InvalidRequest");
      expect(yield* failure(10206)).toEqual("K2RequestTooLarge");
      expect(yield* failure(10207)).toEqual("K2RecordTooLarge");
      expect(yield* failure(10211)).toEqual("K2Unavailable");
      expect(yield* failure(10212)).toEqual("K2AppendOutcomeUnknown");
      expect(yield* failure(99999)).toEqual("UnknownCloudflareError");

      // A rejected RPC means the append outcome is unknown.
      const rejected = yield* sendViaBinding(binding(new Error("rpc reset")), records).pipe(
        Effect.flip,
      );
      expect(rejected._tag).toEqual("K2AppendOutcomeUnknown");
    }),
  );
});
