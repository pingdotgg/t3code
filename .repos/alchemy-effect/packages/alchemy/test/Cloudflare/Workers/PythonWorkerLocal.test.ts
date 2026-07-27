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

const main = pathe.resolve(import.meta.dirname, "fixtures/python/worker.py");

// `dev: true` selects the local provider: the Python entry and its sibling
// modules are served by workerd (which embeds Pyodide) instead of being
// uploaded to Cloudflare. The first start may download the Pyodide runtime
// bundle, so the fetch retries generously.
test.provider(
  "serves a Python Worker from local workerd",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const worker = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.Worker("PythonLocalWorker", {
            main,
            env: { PY_SUFFIX: "local" },
          });
        }),
      );

      expect(worker.url).toBeDefined();
      yield* expectUrlContains(
        worker.url!,
        "alchemy-python-worker-7c1f suffix=local",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);
