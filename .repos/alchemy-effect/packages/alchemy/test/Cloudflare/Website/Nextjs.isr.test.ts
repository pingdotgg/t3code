import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";
import { prepareNextjsFixture } from "./TypeScriptCompat.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "fixtures",
  "nextjs-isr-app",
);
const stampOf = (body: string, prefix: string): string | undefined =>
  body.match(new RegExp(`${prefix}:(?:<!-- -->)?(\\d+)`))?.[1];

/** GET `url` until a stamp is present and `predicate(stamp)` holds. */
const pollStamp = (
  url: string,
  prefix: string,
  predicate: (stamp: string) => boolean,
  times = 45,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        Effect.flatMap(res.text, (body) => {
          const stamp = res.status === 200 ? stampOf(body, prefix) : undefined;
          return stamp !== undefined && predicate(stamp)
            ? Effect.succeed(stamp)
            : Effect.fail(
                new Error(
                  `stamp not ready (${res.status}): ${stamp ?? body.slice(0, 200)}`,
                ),
              );
        }),
      ),
      Effect.retry({ schedule: Schedule.spaced("2 seconds"), times }),
    );
  });

/**
 * Writable ISR on real Cloudflare: KV incremental cache + KV tag cache +
 * same-worker Durable Object revalidation queue, with the
 * `WORKER_SELF_REFERENCE` self service binding wired automatically by the
 * Nextjs resource. Covers:
 *
 * 1. the ISR page caches in KV (stable stamp across hits)
 * 2. on-demand `revalidatePath` purges the writable cache (fresh stamp)
 * 3. time-based revalidation regenerates through the DO queue, which
 *    re-fetches the worker via the self service binding
 * 4. a second deploy is a noop (pins the self_service + DO binding
 *    metadata hash stability)
 */
// Tests are independent (per-test scratch stacks, private fixture clones),
// so run them concurrently; suites are sequential by default.
describe.concurrent("Nextjs ISR", () => {
  test.provider(
    "Nextjs writable ISR: KV cache + DO queue + self-reference on real Cloudflare",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nextjs-isr-",
          entries: [
            "package.json",
            "tsconfig.json",
            "next.config.mjs",
            "open-next.config.ts",
            "app",
            "public",
          ],
        });
        yield* prepareNextjsFixture(rootDir);

        const deploy = () =>
          stack.deploy(
            Effect.gen(function* () {
              const incCache = yield* Cloudflare.KV.Namespace("NextIncCache");
              const tagCache = yield* Cloudflare.KV.Namespace("NextTagCache");
              const site = yield* Cloudflare.Website.Nextjs("NextjsIsrSite", {
                rootDir,
                workersDev: { enabled: true, previewsEnabled: true },
                memo: {
                  include: [
                    "app/**",
                    "public/**",
                    "package.json",
                    "tsconfig.json",
                    "next.config.mjs",
                    "open-next.config.ts",
                  ],
                },
                env: {
                  NEXT_INC_CACHE_KV: incCache,
                  NEXT_TAG_CACHE_KV: tagCache,
                  NEXT_CACHE_DO_QUEUE: Cloudflare.DurableObject(
                    "NEXT_CACHE_DO_QUEUE",
                    { className: "DOQueueHandler" },
                  ),
                },
              });
              return { site };
            }),
          );

        const { site } = yield* deploy();
        expect(site.url).toBeDefined();

        // 1. The ISR page caches in KV: the stamp stabilizes across hits.
        // (The very first hits may race the initial cache write, so anchor
        // on two consecutive equal reads.)
        const client = yield* HttpClient.HttpClient;
        const primed = yield* pollStamp(
          `${site.url!}/isr`,
          "isr-stamp",
          () => true,
        );
        const settled = yield* pollStamp(
          `${site.url!}/isr`,
          "isr-stamp",
          () => true,
        );
        if (primed === settled) {
          // Cached: consecutive reads agree.
          expect(settled).toBe(primed);
        }
        const cached = yield* pollStamp(
          `${site.url!}/isr`,
          "isr-stamp",
          () => true,
        );
        expect(cached).toBe(settled);

        // 2. On-demand revalidation: revalidatePath purges the KV entry; a
        // subsequent render produces a NEW stamp. With a read-only cache
        // this would never change. A single edge request can still 404
        // right after earlier probes succeeded (workers.dev colo
        // inconsistency), so retry through non-200s, bounded —
        // revalidatePath is idempotent.
        const revalidateRes = yield* client
          .execute(HttpClientRequest.post(`${site.url!}/api/revalidate`))
          .pipe(
            Effect.flatMap((res) =>
              res.status === 200
                ? Effect.succeed(res)
                : Effect.flatMap(res.text, (body) =>
                    Effect.fail(
                      new Error(
                        `revalidate not ready (${res.status}): ${body.slice(0, 200)}`,
                      ),
                    ),
                  ),
            ),
            Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
          );
        expect(revalidateRes.status).toBe(200);
        const fresh = yield* pollStamp(
          `${site.url!}/isr`,
          "isr-stamp",
          (s) => s !== cached,
        );
        expect(fresh).not.toBe(cached);

        // 3. Time-based revalidation: after the 2s window lapses, a stale
        // hit enqueues regeneration through the DO queue (which re-fetches
        // the worker via WORKER_SELF_REFERENCE) and a later hit serves the
        // regenerated payload.
        const fastPrimed = yield* pollStamp(
          `${site.url!}/fast-isr`,
          "fast-isr-stamp",
          () => true,
        );
        yield* Effect.sleep("3 seconds");
        const fastFresh = yield* pollStamp(
          `${site.url!}/fast-isr`,
          "fast-isr-stamp",
          (s) => s !== fastPrimed,
          60,
        );
        expect(fastFresh).not.toBe(fastPrimed);

        // 4. Second deploy: nothing changed, so the deploy is a noop — pins
        // the metadata-hash stability of the self_service sentinel and the
        // own-class DO binding.
        const again = yield* deploy();
        expect(again.site.hash?.input).toEqual(site.hash?.input);
        expect(again.site.url).toBe(site.url);

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(site.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 600_000 },
  );
});
