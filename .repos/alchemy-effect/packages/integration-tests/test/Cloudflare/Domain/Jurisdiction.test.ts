import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { call, roundTrip, waitForPlatform } from "./fixtures/counter-client.ts";
import EuWorker from "./fixtures/eu-worker.ts";
import UnrestrictedWorker from "./fixtures/unrestricted-worker.ts";

const { test } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

/**
 * `layerDurableObjects({ jurisdiction: "eu" })` keeps the model's objects in the
 * EU namespace: switching the same Worker to the unrestricted platform finds
 * none of them, and switching back finds them where they were left.
 */
test.provider(
  "a Domain model's Durable Objects live in its jurisdiction",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (worker: typeof EuWorker | typeof UnrestrictedWorker) =>
        stack.deploy(
          Effect.gen(function* () {
            return { worker: yield* worker };
          }),
        );

      const { worker } = yield* deploy(EuWorker);
      const url = worker.url!;
      yield* waitForPlatform(url, "eu");
      yield* roundTrip(url);

      yield* deploy(UnrestrictedWorker);
      yield* waitForPlatform(url, "unrestricted");
      expect(yield* call(`${url}/state/c-1`)).toEqual({ total: 0 });

      yield* deploy(EuWorker);
      yield* waitForPlatform(url, "eu");
      expect(yield* call(`${url}/state/c-1`)).toEqual({ total: 4 });

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 420_000, tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
);
