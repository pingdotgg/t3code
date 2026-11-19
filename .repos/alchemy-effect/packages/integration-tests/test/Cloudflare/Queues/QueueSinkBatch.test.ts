import {
  makeQueueSink,
  MAX_BATCH_BYTES,
  MAX_BATCH_MESSAGES,
  messageSize,
  packQueueSinkBatches,
} from "@alchemy.run/cloudflare/Queues/QueueSinkBatch";
import { SendError, type SendMessage } from "@alchemy.run/cloudflare/Queues/QueueTypes";
import type { WriteQueueClient } from "@alchemy.run/cloudflare/Queues/WriteQueue";
import { describe, expect, it } from "@alchemy.run/test";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";

/**
 * Pure tests of the Cloudflare `QueueSink` batching with a fake
 * `WriteQueue` client. Live delivery is covered by `QueueSink.test.ts`.
 */

const fakeClient = (options?: { failOnBatch?: number }) => {
  const batches: SendMessage[][] = [];
  const client: WriteQueueClient = {
    raw: Effect.die("unused"),
    send: () => Effect.die("unused"),
    sendBatch: (messages) =>
      Effect.suspend(() => {
        if (batches.length === options?.failOnBatch) {
          return Effect.fail(new SendError({ message: "rejected" }));
        }
        batches.push([...messages]);
        return Effect.void;
      }),
  };
  return { client, batches };
};

const run = <A>(stream: Stream.Stream<A>, client: WriteQueueClient) =>
  stream.pipe(
    Stream.run(makeQueueSink(client)),
    Effect.provideService(RuntimeContext, {} as never),
  );

// Synchronous only: restore before the test yields so other fibers cannot see
// the replacement. This exercises no_nodejs_compat without a second deployment.
const withBuffer = <A>(value: unknown, run: () => A): A => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Buffer");
  try {
    Object.defineProperty(globalThis, "Buffer", { value, configurable: true });
    return run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "Buffer", descriptor);
    else Reflect.deleteProperty(globalThis, "Buffer");
  }
};

describe("Cloudflare QueueSink batching", { tags: ["unit", "local"] }, () => {
  it("packs at most 100 messages per batch, preserving order", () => {
    const bodies = Array.from({ length: 250 }, (_, i) => i);
    const batches = packQueueSinkBatches(bodies);
    expect(batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toEqual(bodies);
  });

  it("packs by total size under 256 KB", () => {
    const body = "x".repeat(100_000);
    const batches = packQueueSinkBatches([body, body, body, body, body]);
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1]);
    for (const batch of batches) {
      const bytes = batch.reduce((sum, b) => sum + messageSize(b), 0);
      expect(bytes).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    }
  });

  it("measures UTF-8 JSON bytes plus per-message overhead", () => {
    expect(messageSize("é")).toBe(4 + 100);
    expect(messageSize({ a: 1 })).toBe(7 + 100);
    expect(messageSize(undefined)).toBe(100);
  });

  for (const native of [true, false]) {
    it(`measures Unicode JSON exactly with ${native ? "native" : "web fallback"} byte length`, () => {
      const originalBuffer = globalThis.Buffer;
      const encoder = new TextEncoder();
      let nativeCalls = 0;
      const buffer = native
        ? {
            byteLength(value: string, encoding: "utf8") {
              expect(encoding).toBe("utf8");
              nativeCalls++;
              return originalBuffer.byteLength(value, encoding);
            },
          }
        : undefined;
      withBuffer(buffer, () => {
        const bodies = [
          "",
          'ASCII with "quotes", \\ and \u0000\n',
          "é漢字🌦️",
          "\ud800",
          "\udfff",
          "\ud800x\udfff",
          "\ud800\udfff",
          { "clé🔑": ["😀", "\ud800", "\udfff", null, 123] },
          "東京🌦️".repeat(10_000),
        ];
        for (const body of bodies) {
          expect(messageSize(body)).toBe(encoder.encode(JSON.stringify(body)).length + 100);
        }
        expect(nativeCalls).toBe(native ? bodies.length : 0);

        let toJsonCalls = 0;
        expect(
          messageSize({
            toJSON() {
              toJsonCalls++;
              return "é😀";
            },
          }),
        ).toBe(encoder.encode(JSON.stringify("é😀")).length + 100);
        expect(toJsonCalls).toBe(1);

        const cyclic: { self?: unknown } = {};
        cyclic.self = cyclic;
        const callsBeforeUnsupported = nativeCalls;
        for (const body of [
          undefined,
          () => undefined,
          Symbol("body"),
          1n,
          cyclic,
          {
            toJSON() {
              throw new Error("not serializable");
            },
          },
          { toJSON: () => undefined },
        ]) {
          expect(messageSize(body)).toBe(100);
        }
        expect(nativeCalls).toBe(callsBeforeUnsupported);
      });
    });

    it(`packs Unicode messages at the exact byte boundary with ${native ? "native" : "web fallback"} byte length`, () => {
      withBuffer(native ? globalThis.Buffer : undefined, () => {
        // Two messages: JSON quotes (4) + metadata (200) + 4 bytes per é pair.
        const body = "é".repeat((MAX_BATCH_BYTES - 204) / 4);
        expect(messageSize(body) * 2).toBe(MAX_BATCH_BYTES);
        expect(packQueueSinkBatches([body, body, "next"]).map((batch) => batch.length)).toEqual([
          2, 1,
        ]);
        expect(packQueueSinkBatches([`${body}é`, `${body}é`]).map((batch) => batch.length)).toEqual(
          [1, 1],
        );
      });
    });
  }

  it("ships an oversized message alone", () => {
    const huge = "x".repeat(MAX_BATCH_BYTES);
    expect(packQueueSinkBatches(["a", huge, "b"]).map((b) => b.length)).toEqual([1, 1, 1]);
  });

  it.effect("sends one sendBatch per chunk", () =>
    Effect.gen(function* () {
      const { client, batches } = fakeClient();
      yield* run(Stream.fromIterable([1, 2, 3, 4, 5]).pipe(Stream.rechunk(2)), client);
      expect(batches.map((b) => b.map((m) => m.body))).toEqual([[1, 2], [3, 4], [5]]);
    }),
  );

  it.effect("splits an oversized chunk into consecutive batches", () =>
    Effect.gen(function* () {
      const { client, batches } = fakeClient();
      const bodies = Array.from({ length: 250 }, (_, i) => ({ i }));
      yield* run(Stream.fromIterable(bodies), client);
      expect(batches.map((b) => b.length)).toEqual([MAX_BATCH_MESSAGES, MAX_BATCH_MESSAGES, 50]);
      expect(batches.flat().map((m) => m.body)).toEqual(bodies);
    }),
  );

  it.effect("fails the sink with the SendError and stops sending", () =>
    Effect.gen(function* () {
      const { client, batches } = fakeClient({ failOnBatch: 1 });
      const exit = yield* run(
        Stream.fromIterable(Array.from({ length: 250 }, (_, i) => i)),
        client,
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(batches.length).toBe(1);
    }),
  );
});
