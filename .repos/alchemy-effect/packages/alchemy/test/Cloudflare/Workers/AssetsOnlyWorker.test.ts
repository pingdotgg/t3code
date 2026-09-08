import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { describe } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures/assets-only");

class NotFoundAssertionFailed extends Data.TaggedError(
  "NotFoundAssertionFailed",
)<{
  url: string;
  status: number;
  bodyExcerpt: string;
}> {}

/**
 * Assert `url` serves the custom 404 page: status 404 with the fixture's
 * `404.html` marker in the body. `expectUrlContains` requires `res.ok`,
 * so this needs its own retry loop.
 */
const expectCustom404 = (url: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const res = await fetch(url, { signal, cache: "no-store" });
      const body = await res.text();
      if (res.status !== 404 || !body.includes("alchemy-assets-only-404")) {
        throw new NotFoundAssertionFailed({
          url,
          status: res.status,
          bodyExcerpt: body.slice(0, 240),
        });
      }
    },
    catch: (e) =>
      e instanceof NotFoundAssertionFailed
        ? e
        : new NotFoundAssertionFailed({
            url,
            status: 0,
            bodyExcerpt: e instanceof Error ? e.message : String(e),
          }),
  }).pipe(
    Effect.retry({
      schedule: Schedule.exponential("750 millis", 1.5),
      times: 10,
    }),
  );

describe.concurrent("Cloudflare.Worker assets-only", () => {
  test.provider(
    "deploys, updates, and converts an assets-only Worker",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const deploy = (props: {
          assets: string | { directory: string; notFoundHandling?: "404-page" };
          script?: string;
        }) =>
          stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Worker("AssetsOnly", {
                ...props,
                workersDev: true,
                compatibility: { date: "2024-01-01" },
              });
            }),
          );

        // 1. Fresh assets-only deploy: no main, no script — Cloudflare's
        //    asset layer serves everything, including the custom 404 page.
        const worker = yield* deploy({
          assets: { directory: fixtureDir, notFoundHandling: "404-page" },
        });
        const url = worker.url!;
        yield* expectUrlContains(`${url}/`, "alchemy-assets-only-index");
        yield* expectCustom404(`${url}/does-not-exist`);

        // 2. Update: editing an asset must redeploy the new content.
        const dir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-assets-only-",
        });
        yield* fs.writeFileString(
          path.join(dir, "index.html"),
          "<html><body>alchemy-assets-only-index-v2</body></html>",
        );
        yield* deploy({
          assets: { directory: dir, notFoundHandling: "404-page" },
        });
        yield* expectUrlContains(`${url}/`, "alchemy-assets-only-index-v2", {
          label: "updated asset",
        });

        // 3. Convert to a script Worker: unmatched routes now invoke the
        //    script instead of the asset layer's 404 handling.
        yield* deploy({
          assets: dir,
          script: `export default { fetch: () => new Response("alchemy-assets-only-script") };`,
        });
        yield* expectUrlContains(
          `${url}/does-not-exist`,
          "alchemy-assets-only-script",
          { label: "script fallback after conversion" },
        );

        // 4. Convert back to assets-only: the stored bundle hash must not
        //    mask the change, and the asset layer owns 404s again.
        yield* deploy({
          assets: { directory: dir, notFoundHandling: "404-page" },
        });
        yield* expectCustom404(`${url}/does-not-exist`);
        yield* expectUrlContains(`${url}/`, "alchemy-assets-only-index-v2", {
          label: "assets serve after conversion back",
        });

        yield* stack.destroy();
      }),
    { timeout: 360_000 },
  );

  test.provider(
    "class form deploys an assets-only Worker",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        class Site extends Cloudflare.Worker<Site>()("AssetsOnlyClass", {
          assets: {
            directory: fixtureDir,
            notFoundHandling: "404-page",
          },
          workersDev: true,
          compatibility: { date: "2024-01-01" },
        }) {}

        const worker = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Site;
          }),
        );
        const url = worker.url!;
        yield* expectUrlContains(`${url}/`, "alchemy-assets-only-index");
        yield* expectCustom404(`${url}/does-not-exist`);

        yield* stack.destroy();
      }),
    { timeout: 240_000 },
  );
});
