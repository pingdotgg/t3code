import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { expectUrlContains } from "../Utils/Http.ts";
import CacheTestWorker from "./fixtures/cache/cache-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The worker stamps every invocation with a fresh UUID, so two fetches of
// the same URL returning the same body means the second response was served
// from the Workers Cache without invoking the worker.
const cachedScript = `export default {
  async fetch() {
    return new Response("id:" + crypto.randomUUID(), {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  },
};
`;

const fetchCached = (url: string) =>
  Effect.tryPromise(async (signal) => {
    // NO cache-busting here — the whole point is hitting the same cache key.
    const res = await fetch(url, { signal });
    return {
      status: res.status,
      cacheStatus: res.headers.get("cf-cache-status"),
      body: await res.text(),
    };
  });

// Poll `url` until two consecutive responses carry the same worker-stamped
// body ("id:<uuid>"), proving the second was served from the Workers Cache
// without invoking the worker. Only marker-carrying bodies participate:
// workers.dev placeholder pages also serve identical 200 bodies, so an
// unanchored comparison would count two placeholders as a false "hit".
// Bounded so a broken cache fails fast instead of hitting the vitest
// timeout.
const pollForCacheHit = (url: string) => {
  let previous: string | undefined;
  return fetchCached(url).pipe(
    Effect.map((res) => {
      const isWorkerBody = res.status === 200 && res.body.startsWith("id:");
      const isHit =
        (isWorkerBody && previous !== undefined && res.body === previous) ||
        res.cacheStatus === "HIT";
      if (isWorkerBody) {
        previous = res.body;
      }
      return { ...res, isHit };
    }),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (res) => res.isHit,
      times: 20,
    }),
  );
};

test.provider(
  "worker with Workers Cache enabled serves repeat requests from cache",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { worker } = yield* stack.deploy(
        Effect.gen(function* () {
          return {
            worker: yield* Cloudflare.Worker("CachedWorker", {
              script: cachedScript,
              cache: {
                enabled: true,
                crossVersionCache: true,
              },
            }),
          };
        }),
      );
      expect(worker.url).toBeDefined();

      // Ride out workers.dev propagation before probing cache behavior.
      yield* expectUrlContains(worker.url!, "id:", {
        label: "cached worker propagation",
      });

      const hit = yield* pollForCacheHit(`${worker.url}/cached`);
      expect(hit.isHit).toBe(true);

      // Metadata-only update: same script, cache turned off. The metadata
      // hash must register the change and the API must accept the update.
      const disabled = yield* stack.deploy(
        Effect.gen(function* () {
          return {
            worker: yield* Cloudflare.Worker("CachedWorker", {
              script: cachedScript,
              cache: {
                enabled: false,
              },
            }),
          };
        }),
      );
      expect(disabled.worker.workerName).toEqual(worker.workerName);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

// Effect-native path: `yield* Cloudflare.cache()` in the init phase enables
// Workers Cache via the binding contract (no `cache` prop) and returns the
// runtime purge client backed by `ctx.cache`.
test.provider(
  "Cloudflare.cache() enables the cache and purges by tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { worker } = yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* CacheTestWorker };
        }),
      );
      expect(worker.url).toBeDefined();

      yield* expectUrlContains(`${worker.url}/item`, "id:", {
        label: "cache worker propagation",
      });

      // Poll the same URL until a repeat body proves the binding actually
      // enabled the cache.
      const url = `${worker.url}/item`;
      const hit = yield* pollForCacheHit(url);
      expect(hit.isHit).toBe(true);
      const cachedBody = hit.body;

      // Purge by Cache-Tag through the runtime client. Retried until the
      // response parses as JSON — transient placeholders/5xx bodies throw
      // and retry; a parsed `success: false` is a genuine failure and
      // surfaces via the assertion.
      const purged = yield* Effect.sync(
        () => `${worker.url}/purge?cb=${Date.now()}`,
      ).pipe(
        Effect.flatMap(fetchCached),
        Effect.flatMap((res) =>
          res.status === 200
            ? Effect.try(() => JSON.parse(res.body) as { success: boolean })
            : Effect.fail(new Error(`Purge worker not ready: ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.spaced("2 seconds"),
          times: 10,
        }),
      );
      expect(purged.success).toBe(true);

      // A fresh invocation id proves the tag purge evicted the entry. The
      // marker check keeps a placeholder page (also ≠ cachedBody) from
      // passing as "fresh".
      const fresh = yield* fetchCached(url).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (res) =>
            res.status === 200 &&
            res.body.startsWith("id:") &&
            res.body !== cachedBody,
          times: 20,
        }),
      );
      expect(fresh.body).not.toBe(cachedBody);
      expect(fresh.body.startsWith("id:")).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);
