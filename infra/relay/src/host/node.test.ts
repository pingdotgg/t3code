import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as TestClock from "effect/testing/TestClock";

import type * as RelayDb from "../db.ts";
import { fixedWindowLimit, makeNodeHost } from "./node.ts";
import * as Ports from "./ports.ts";

const layer = Layer.mergeAll(SecureRandom.layerWebCrypto, FetchHttpClient.layer);

const makeHost = makeNodeHost({
  relayPublicOrigin: "https://relay.example.com",
  stage: "selfhost",
  mintKeyPair: { privateKey: Redacted.make("private"), publicKey: "public" },
  // The queue and scheduler never touch the database.
  database: {} as RelayDb.RelayDb["Service"],
  mobileTelemetry: { token: undefined, traces: "", logs: "", metrics: "" },
});

describe("fixedWindowLimit", () => {
  it.effect("allows the limit per key within a window and resets after it", () =>
    Effect.gen(function* () {
      const limit = fixedWindowLimit(2, 60);

      expect([yield* limit("a"), yield* limit("a"), yield* limit("a")]).toEqual([
        true,
        true,
        false,
      ]);
      expect(yield* limit("b")).toBe(true);

      yield* TestClock.adjust("60 seconds");
      expect(yield* limit("a")).toBe(true);
    }),
  );
});

describe("self-hosted queue and scheduler", () => {
  it.effect("retries a failed job after the retry delay and drops it after maxRetries", () =>
    Effect.gen(function* () {
      const host = yield* makeHost;
      const sender = yield* host.fcmSender;
      const attempts = yield* Queue.unbounded<number>();
      let seen = 0;
      yield* host.consumeQueue(
        "fcm",
        { batchSize: 10, maxRetries: 3, retryDelay: "30 seconds" },
        () =>
          Queue.offer(attempts, (seen += 1)).pipe(
            Effect.andThen(Effect.fail(new Ports.QueueHandlerError({ cause: "rejected" }))),
          ),
      );

      yield* sender.send({} as never);
      expect(yield* Queue.take(attempts)).toBe(1);
      yield* TestClock.adjust("30 seconds");
      expect(yield* Queue.take(attempts)).toBe(2);
      yield* TestClock.adjust("30 seconds");
      expect(yield* Queue.take(attempts)).toBe(3);

      yield* TestClock.adjust("30 seconds");
      expect(yield* Queue.size(attempts)).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("runs a `*/N * * * *` schedule every N minutes and rejects other expressions", () =>
    Effect.gen(function* () {
      const host = yield* makeHost;
      const runs = yield* Queue.unbounded<number>();
      let count = 0;
      yield* host.schedule(
        "*/5 * * * *",
        Effect.suspend(() => Queue.offer(runs, (count += 1))).pipe(Effect.asVoid),
      );

      yield* TestClock.adjust("5 minutes");
      expect(yield* Queue.take(runs)).toBe(1);
      yield* TestClock.adjust("5 minutes");
      expect(yield* Queue.take(runs)).toBe(2);

      expect(Exit.isFailure(yield* Effect.exit(host.schedule("0 * * * *", Effect.void)))).toBe(
        true,
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
