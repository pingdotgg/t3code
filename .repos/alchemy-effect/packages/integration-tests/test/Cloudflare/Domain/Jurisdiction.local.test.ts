import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { roundTrip } from "./fixtures/counter-client.ts";
import DomainCounterWorker from "./fixtures/eu-worker.ts";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

/**
 * Local workerd does not implement Durable Object jurisdictions, so under
 * `alchemy dev` `layerDurableObjects({ jurisdiction: "eu" })` runs the model
 * unrestricted, as a D1 database, R2 bucket or Queue with a jurisdiction does.
 * Every kind of object, and the workflow engine, must still work.
 */
test.provider(
  "a Domain model declared with an EU jurisdiction runs in alchemy dev",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { worker } = yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* DomainCounterWorker };
        }),
      );
      expect(worker.url).toMatch(/^http:\/\/localhost:\d+$/);
      yield* roundTrip(worker.url!);
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000, tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"] },
);
