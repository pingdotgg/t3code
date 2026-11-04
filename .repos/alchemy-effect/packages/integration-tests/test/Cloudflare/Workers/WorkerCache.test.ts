import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { expectUrlContains } from "../Utils/Http.ts";
import CacheTestWorker from "./fixtures/cache/cache-worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

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
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 240_000,
  },
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
      // and retry — and reports success: the purge runs on a token the
      // binding just minted, which can be rejected until it propagates. A
      // purge still failing after the retries surfaces its errors below.
      const purged = yield* Effect.sync(() => `${worker.url}/purge?cb=${Date.now()}`).pipe(
        Effect.flatMap(fetchCached),
        Effect.flatMap((res) =>
          res.status === 200
            ? Effect.try(() => JSON.parse(res.body) as { success: boolean; errors?: unknown })
            : Effect.fail(new Error(`Purge worker not ready: ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.spaced("2 seconds"),
          times: 10,
        }),
        Effect.repeat({
          until: (result) => result.success,
          schedule: Schedule.spaced("2 seconds"),
          times: 10,
        }),
      );
      expect(purged).toMatchObject({ success: true });

      // A fresh invocation id proves the tag purge evicted the entry. The
      // marker check keeps a placeholder page (also ≠ cachedBody) from
      // passing as "fresh".
      const fresh = yield* fetchCached(url).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (res) =>
            res.status === 200 && res.body.startsWith("id:") && res.body !== cachedBody,
          times: 20,
        }),
      );
      expect(fresh.body).not.toBe(cachedBody);
      expect(fresh.body.startsWith("id:")).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:cache",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 240_000,
  },
);

// A gateway default export that forwards to a named `Public` entrypoint via
// `ctx.exports`. Each layer stamps its own UUID, so one response body shows
// which layer ran: a repeated `pub:` id with a fresh `gw:` id means only
// `Public` was served from cache; a fully repeated body means the gateway
// itself was cached.
const entrypointScript = `import { WorkerEntrypoint } from "cloudflare:workers";

export class Public extends WorkerEntrypoint {
  async fetch() {
    return new Response("pub:" + crypto.randomUUID(), {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  }
}

export default {
  async fetch(request, env, ctx) {
    const inner = await ctx.exports.Public.fetch(request);
    return new Response("gw:" + crypto.randomUUID() + "|" + (await inner.text()), {
      headers: { "Cache-Control": "public, max-age=300" },
    });
  },
};
`;

const parseLayers = (body: string) => {
  const match = /^gw:([^|]+)\|pub:(.+)$/.exec(body);
  return match ? { gateway: match[1]!, public: match[2]! } : undefined;
};

// Poll until two consecutive worker-stamped responses satisfy `isHit`.
const pollForLayers = (
  url: string,
  isHit: (
    previous: { gateway: string; public: string },
    current: { gateway: string; public: string },
  ) => boolean,
) => {
  let previous: { gateway: string; public: string } | undefined;
  return fetchCached(url).pipe(
    Effect.map((res) => {
      const current = res.status === 200 ? parseLayers(res.body) : undefined;
      const hit = current !== undefined && previous !== undefined && isHit(previous, current);
      if (current) previous = current;
      return { ...res, hit };
    }),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (res) => res.hit,
      times: 20,
    }),
  );
};

// The `exports` map Cloudflare recorded on the version serving traffic.
const liveExports = (scriptName: string) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const { deployments } = yield* workers.listScriptDeployments({ accountId, scriptName });
    const versionId = deployments[0]!.versions[0]!.versionId;
    const version = yield* workers.getScriptVersion({ accountId, scriptName, versionId });
    return version.resources?.scriptRuntime?.exports ?? {};
  });

test.provider(
  "entrypoints configures Workers Cache per entrypoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Uncached gateway in front of a cached `Public` entrypoint, with no
      // Worker-wide `cache` at all.
      const { worker } = yield* stack.deploy(
        Effect.gen(function* () {
          return {
            worker: yield* Cloudflare.Worker("EntrypointCacheWorker", {
              script: entrypointScript,
              entrypoints: {
                default: { cache: { enabled: false } },
                Public: { cache: { enabled: true } },
              },
            }),
          };
        }),
      );
      expect(worker.url).toBeDefined();
      const exports = yield* liveExports(worker.workerName);
      expect(exports.default).toMatchObject({ type: "worker", cache: { enabled: false } });
      expect(exports.Public).toMatchObject({ type: "worker", cache: { enabled: true } });

      yield* expectUrlContains(worker.url!, "gw:", {
        label: "entrypoint cache worker propagation",
      });

      const publicHit = yield* pollForLayers(
        `${worker.url}/gateway`,
        (previous, current) =>
          current.public === previous.public && current.gateway !== previous.gateway,
      );
      expect(publicHit.hit).toBe(true);

      // Flip it: cache the gateway, not `Public`. The new version starts
      // cold; a fully repeated body proves the default export is cached.
      const flipped = yield* stack.deploy(
        Effect.gen(function* () {
          return {
            worker: yield* Cloudflare.Worker("EntrypointCacheWorker", {
              script: entrypointScript,
              entrypoints: {
                default: { cache: { enabled: true } },
                Public: { cache: { enabled: false } },
              },
            }),
          };
        }),
      );
      expect(flipped.worker.workerName).toEqual(worker.workerName);
      const flippedExports = yield* liveExports(worker.workerName);
      expect(flippedExports.default).toMatchObject({ type: "worker", cache: { enabled: true } });
      expect(flippedExports.Public).toMatchObject({ type: "worker", cache: { enabled: false } });

      const gatewayHit = yield* pollForLayers(
        `${worker.url}/gateway`,
        (previous, current) => current.gateway === previous.gateway,
      );
      expect(gatewayHit.hit).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 240_000,
  },
);

// The `exports` map Cloudflare recorded on one version.
const versionExports = (scriptName: string, versionId: string) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const version = yield* workers.getScriptVersion({ accountId, scriptName, versionId });
    return version.resources?.scriptRuntime?.exports ?? {};
  });

// Unlike Durable Object exports, entrypoint cache overrides may differ
// between the versions of a gradual rollout: each version carries its own.
test.provider(
  "a gradual rollout may change an entrypoint's cache setting",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (publicCache: boolean, marker: string, traffic?: number) =>
        Cloudflare.Worker("EntrypointGradualWorker", {
          script: `${entrypointScript}\n// ${marker}\n`,
          entrypoints: { Public: { cache: { enabled: publicCache } } },
          ...(traffic !== undefined ? { version: { traffic } } : {}),
        });

      const base = yield* stack.deploy(program(true, "v1"));
      const gradual = yield* stack.deploy(program(false, "v2", 50));
      expect(gradual.versionId).toBeDefined();

      const { accountId } = yield* yield* CloudflareEnvironment;
      const { deployments } = yield* workers.listScriptDeployments({
        accountId,
        scriptName: base.workerName,
      });
      const split = deployments[0]?.versions ?? [];
      expect(split.map((v) => v.percentage)).toEqual([50, 50]);
      const previous = split.find((v) => v.versionId !== gradual.versionId)!;
      expect(split.some((v) => v.versionId === gradual.versionId)).toBe(true);

      expect((yield* versionExports(base.workerName, previous.versionId)).Public).toMatchObject({
        type: "worker",
        cache: { enabled: true },
      });
      expect((yield* versionExports(base.workerName, gradual.versionId!)).Public).toMatchObject({
        type: "worker",
        cache: { enabled: false },
      });

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 240_000,
  },
);

// Previews upload their own `exports` map: the gateway/`Public` split
// applies on the Preview URL, independent of the parent's settings.
test.provider(
  "a preview applies its own entrypoint cache settings",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { preview } = yield* stack.deploy(
        Effect.gen(function* () {
          const parent = yield* Cloudflare.Worker("EntrypointCacheParent", {
            script: cachedScript,
          });
          const preview = yield* Cloudflare.Worker("EntrypointCachePreview", {
            script: entrypointScript,
            preview: { of: parent },
            entrypoints: {
              default: { cache: { enabled: false } },
              Public: { cache: { enabled: true } },
            },
          });
          return { parent, preview };
        }),
      );
      expect(preview.url).toBeDefined();

      yield* expectUrlContains(preview.url!, "gw:", {
        label: "entrypoint cache preview propagation",
      });

      const publicHit = yield* pollForLayers(
        `${preview.url}/gateway`,
        (previous, current) =>
          current.public === previous.public && current.gateway !== previous.gateway,
      );
      expect(publicHit.hit).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 240_000,
  },
);

// Cloudflare rejects an `exports` cache override naming an export the script
// doesn't have (code 10375); the deploy fails with that typed tag.
test.provider(
  "entrypoints naming an unknown export fails with UnknownWorkerEntrypoint",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* stack
        .deploy(
          Cloudflare.Worker("UnknownEntrypointWorker", {
            script: cachedScript,
            entrypoints: { Missing: { cache: { enabled: true } } },
          }),
        )
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "UnknownWorkerEntrypoint", code: 10375 });

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 120_000,
  },
);
