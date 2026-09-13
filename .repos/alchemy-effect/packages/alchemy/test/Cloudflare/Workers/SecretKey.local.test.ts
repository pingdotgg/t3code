import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import SecretKeyWorker from "./fixtures/secret-key/worker.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

/**
 * `secret_key` bindings are lowered to workerd's native
 * `Worker_Binding.cryptoKey` config under the local runtime, so the dev
 * worker sees real non-extractable `CryptoKey`s in `env`. The fixture
 * carries the same HMAC material as a `raw` binding and a `jwk` binding
 * and cross-verifies a signature between them.
 */
test.provider(
  "secret_key bindings become native CryptoKeys under the local runtime",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* SecretKeyWorker;
          return { worker };
        }),
      );

      // The local provider serves from the dev proxy — proof no cloud call
      // ran.
      expect(deployed.worker.url).toMatch(/^http:\/\/localhost:\d+$/);

      const url = deployed.worker.url;
      const client = yield* HttpClient.HttpClient;

      const res = yield* Effect.gen(function* () {
        const res = yield* client.get(`${url}/`);
        if (res.status !== 200) {
          return yield* Effect.fail(new WorkerNotReady({ status: res.status }));
        }
        return res;
      }).pipe(
        Effect.retry({
          schedule: Schedule.exponential("500 millis"),
          times: 10,
        }),
      );

      const body = (yield* res.json) as {
        crossVerified: boolean;
        rawIsCryptoKey: boolean;
        jwkIsCryptoKey: boolean;
        algorithm: string;
        usages: string[];
        extractable: boolean;
      };
      // A signature from the raw-format key verifies with the jwk-format
      // key — both formats imported the same material correctly.
      expect(body.crossVerified).toBe(true);
      expect(body.rawIsCryptoKey).toBe(true);
      expect(body.jwkIsCryptoKey).toBe(true);
      expect(body.algorithm).toBe("HMAC");
      expect(body.usages).toEqual(["sign", "verify"]);
      // The Cloudflare API never marks bound keys extractable; the local
      // lowering matches.
      expect(body.extractable).toBe(false);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
