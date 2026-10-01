import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "fixtures/assets-routing",
);
const main = pathe.resolve(fixtureDir, "worker.ts");
const assetsDir = pathe.resolve(fixtureDir, "assets");

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

const getTextReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("2 seconds"),
          ]),
          Schedule.recurs(10),
        ]),
      }),
    );
    return yield* res.text;
  }).pipe(Effect.orDie);

/**
 * Pins `runWorkerFirst` routing through the local dev pipeline
 * (LocalWorkerProvider → cloudflare-runtime), matching deployed behavior:
 *
 * - omitted → assets-first: a request matching an asset never invokes the
 *   worker (the #1121 dev default fix)
 * - a glob array → only matching paths go worker-first, shadowing even a
 *   matching asset; everything else stays assets-first (a boolean coercion
 *   of the array anywhere along the pass-through fails one direction or
 *   the other)
 *
 * The fixture makes the answering layer observable: the worker echoes
 * `assets-routing-worker:<path>` for every request, and the assets
 * directory contains `index.html` plus `api/hello.txt` — a path that both
 * layers can answer.
 */
test.provider(
  "dev runWorkerFirst routing: assets-first default and selective glob arrays",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const globs = yield* Cloudflare.Worker("assets-routing-globs", {
            main,
            assets: {
              directory: assetsDir,
              runWorkerFirst: ["/api/*"],
            },
          });
          const defaults = yield* Cloudflare.Worker("assets-routing-default", {
            main,
            assets: { directory: assetsDir },
          });
          return { globs, defaults };
        }),
      );

      // Both serve from the local dev proxy — proof no cloud call ran.
      expect(deployed.globs.url).toMatch(/^http:\/\/localhost:\d+$/);
      expect(deployed.defaults.url).toMatch(/^http:\/\/localhost:\d+$/);

      // ── glob array ────────────────────────────────────────────────────
      // `/` is outside the globs: the asset answers. If the array were
      // coerced to blanket worker-first, the worker's echo would win.
      const globsIndex = yield* getTextReady(`${deployed.globs.url}/`);
      expect(globsIndex).toContain("alchemy-assets-routing-index");

      // `/api/hello.txt` matches both an asset and the `/api/*` glob: the
      // worker must answer. If the array were dropped (treated as false),
      // the asset would serve instead.
      const globsApi = yield* getTextReady(
        `${deployed.globs.url}/api/hello.txt`,
      );
      expect(globsApi).toBe("assets-routing-worker:/api/hello.txt");

      // A path neither layer claims still falls through to the worker.
      const globsMiss = yield* getTextReady(`${deployed.globs.url}/nothing`);
      expect(globsMiss).toBe("assets-routing-worker:/nothing");

      // ── omitted (assets-first default) ────────────────────────────────
      // The same both-layers path now serves the asset: the worker is only
      // invoked for requests with no matching asset — deployed behavior.
      const defaultApi = yield* getTextReady(
        `${deployed.defaults.url}/api/hello.txt`,
      );
      expect(defaultApi).toContain("alchemy-assets-routing-api-asset");

      const defaultMiss = yield* getTextReady(
        `${deployed.defaults.url}/nothing`,
      );
      expect(defaultMiss).toBe("assets-routing-worker:/nothing");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
