import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { expectUrlContains } from "../Utils/Http.ts";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const main = pathe.resolve(import.meta.dirname, "fixtures/prebuilt/worker.mjs");

// `dev: true` selects the local provider. A `bundle: false` Worker must be
// served byte-for-byte in local dev exactly like the deploy path: the entry
// plus its rule-matched siblings (nested ES modules AND the nested text
// module) are handed to workerd as-is.
//
// Regression: the local provider used to run every non-Python `main`
// through the rolldown watcher, re-bundling the prebuilt artifact. That
// broke the byte-for-byte contract outright — this fixture's `.txt` module
// import isn't even bundleable — so local dev of `bundle: false` workers
// failed while deploy worked. The prebuilt source now fs-watches and
// re-reads the module graph instead of bundling.
test.provider(
  "serves a prebuilt (bundle: false) Worker byte-for-byte from local workerd",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Worker("PrebuiltLocalWorker", {
            main,
            bundle: false,
            compatibility: {
              date: "2024-01-01",
            },
          });
        }),
      );

      expect(worker.url).toBeDefined();
      // The response is assembled across both nested ES modules and the
      // nested text module — it can only be produced when the full module
      // graph reached workerd unbundled.
      yield* expectUrlContains(
        worker.url!,
        "prebuilt-modules-survived alchemy-prebuilt-notice-4d2a!",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
