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

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures/assets-only");

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
 * An assets-only Worker (no `main`, no `script`) under `alchemy dev`: the
 * local provider serves a stub that delegates every request to the ASSETS
 * binding, so static files and the asset layer's 404 handling work without
 * any entry module.
 */
test.provider(
  "assets-only worker serves static files locally",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const worker = yield* Cloudflare.Worker("assets-only-local", {
            assets: { directory: fixtureDir, notFoundHandling: "404-page" },
          });
          return { worker };
        }),
      );

      // The local provider serves from the dev proxy — proof no cloud call
      // ran.
      expect(deployed.worker.url).toMatch(/^http:\/\/localhost:\d+$/);

      const body = yield* getTextReady(`${deployed.worker.url}`);
      expect(body).toContain("alchemy-assets-only-index");

      // The asset layer's custom 404 page is applied by the assets worker
      // itself — the stub only delegates.
      const client = yield* HttpClient.HttpClient;
      const missing = yield* client
        .get(`${deployed.worker.url}/does-not-exist`)
        .pipe(Effect.orDie);
      expect(missing.status).toBe(404);
      const missingBody = yield* missing.text.pipe(Effect.orDie);
      expect(missingBody).toContain("alchemy-assets-only-404");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
