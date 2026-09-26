import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import * as r2 from "@distilled.cloud/cloudflare/r2";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectUrlContains } from "../Utils/Http.ts";
import {
  expectWorkerExists,
  waitForWorkerToBeDeleted,
} from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "tanstack-dev-bindings-fixture",
);

// Vite project roots must stay reachable via a sane relative path from the
// process cwd (see Vite.test.ts) — clone under the package's own `.tmp/`.
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

describe.concurrent("TanStack Start", () => {
  /**
   * TanStack Start deploys through `Cloudflare.Website.Vite` (per the Vite
   * resource's TanStack example) — the `tanstackStart()` plugin in the
   * fixture's own `vite.config.ts` composes with the injected Cloudflare
   * plugin. This is the live-deploy counterpart to the dev-mode coverage in
   * Vite.test.ts: SSR HTML on a raw fetch, a server route answering, the
   * client asset serving, and an R2 binding round-trip.
   */
  test.provider(
    "TanStack Start: live deploy serves SSR, server routes, assets, and R2 bindings",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-tanstack-live-",
          tempRoot,
          entries: [
            "alchemy.run.ts",
            "package.json",
            "tsconfig.json",
            "vite.config.ts",
            "src",
          ],
        });
        const memoInclude = [
          "src/**",
          "package.json",
          "tsconfig.json",
          "vite.config.ts",
          "alchemy.run.ts",
        ];

        const marker = "tanstack-live-marker";

        const { site, bucket } = yield* stack.deploy(
          Effect.gen(function* () {
            const bucket = yield* Cloudflare.R2.Bucket("TanStackLiveBucket", {
              forceDestroy: true,
            });
            const site = yield* Cloudflare.Website.Vite("TanStackStartLive", {
              rootDir,
              workersDev: true,
              compatibility: {
                date: "2024-09-23",
                flags: ["nodejs_compat"],
              },
              // No `assets` config (mirroring the Vite resource's TanStack
              // example): client assets serve asset-first from the asset
              // layer, everything else (SSR routes, /api/*) falls through
              // to the TanStack server handler. `runWorkerFirst: true`
              // would route `/assets/*` into the worker, which 404s them.
              memo: { include: memoInclude },
              env: {
                BUCKET: bucket,
                DEV_MARKER: marker,
              },
            });
            return { site, bucket };
          }),
        );

        expect(site.url).toBeDefined();
        yield* expectWorkerExists(site.workerName, accountId);

        // ── SSR: the index route's component renders server-side ─────────
        // `hmr-marker-fixture` is the constant baked into the fixture's
        // index route — a raw fetch (no client JS) must carry it.
        yield* expectUrlContains(`${site.url!}/`, "hmr-marker-fixture", {
          timeout: "120 seconds",
          label: "tanstack ssr home",
        });

        // ── Server route + R2 binding round-trip ─────────────────────────
        const key = "tanstack-live-key.txt";
        const r2Url = `${site.url!}/api/r2?key=${encodeURIComponent(key)}`;

        const put = yield* putTextJsonReady<{ ok: boolean; marker: string }>(
          r2Url,
          "tanstack-live-value",
        );
        expect(put.ok).toBe(true);
        // The env binding reached the server route.
        expect(put.marker).toBe(marker);

        const get = yield* fetchJsonReady<{
          marker: string;
          value: string | null;
        }>(r2Url);
        expect(get.value).toBe("tanstack-live-value");
        expect(get.marker).toBe(marker);

        // ── Static asset: the client bundle the SSR HTML references ──────
        yield* expectClientScriptServes(site.url!);

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(site.workerName, accountId);
        yield* waitForBucketToBeDeleted(bucket.bucketName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );
});

const freshConn = HttpClient.mapRequest(
  HttpClientRequest.setHeader("connection", "close"),
);

const fetchJsonReady = <T>(url: string) =>
  Effect.gen(function* () {
    const client = freshConn(yield* HttpClient.HttpClient);
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.flatMap(res.text, (body) =>
              Effect.try({
                try: () => JSON.parse(body) as T,
                catch: () => new Error(`non-json body: ${body}`),
              }),
            )
          : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
      ),
      Effect.retry({
        // Capped interval, ~90s total budget (workers.dev / DO propagation).
        schedule: Schedule.min([
          Schedule.exponential("500 millis"),
          Schedule.spaced("2 seconds"),
        ]),
        times: 45,
      }),
    );
  });

const putTextJsonReady = <T>(url: string, body: string) =>
  Effect.gen(function* () {
    return yield* HttpClient.execute(
      HttpClientRequest.put(url).pipe(
        HttpClientRequest.bodyText(body, "text/plain"),
      ),
    ).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.flatMap(res.text, (responseBody) =>
              Effect.try({
                try: () => JSON.parse(responseBody) as T,
                catch: () => new Error(`non-json body: ${responseBody}`),
              }),
            )
          : Effect.fail(new Error(`Worker not ready: ${res.status}`)),
      ),
      Effect.retry({
        // Capped interval, ~90s total budget (workers.dev / DO propagation).
        schedule: Schedule.min([
          Schedule.exponential("500 millis"),
          Schedule.spaced("2 seconds"),
        ]),
        times: 45,
      }),
    );
  });

/**
 * Discover a client `<script src="…​.js">` from the served SSR HTML and
 * assert the referenced asset serves as JavaScript (not the Cloudflare
 * placeholder page or an HTML error body). Re-discovers the script URL on
 * every attempt — the bundle filename is content-addressed and the edge can
 * briefly serve a stale index.
 */
const expectClientScriptServes = (siteUrl: string) =>
  Effect.gen(function* () {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    yield* Effect.gen(function* () {
      const res = yield* client.get(`${siteUrl}/`, {
        urlParams: { __alchemy_cb: String(Date.now()) },
        headers: { "cache-control": "no-cache", pragma: "no-cache" },
      });
      const html = yield* res.text;
      const match = html.match(/<script[^>]+src="(\/[^"]+\.js[^"]*)"/i);
      if (!match) {
        return yield* Effect.fail(
          new Error(`no client script tag in SSR HTML: ${html.slice(0, 200)}`),
        );
      }
      const assetRes = yield* client.get(`${siteUrl}${match[1]}`);
      const contentType = assetRes.headers["content-type"] ?? "";
      const body = yield* assetRes.text;
      if (!contentType.includes("javascript") || body.includes("<html")) {
        return yield* Effect.fail(
          new Error(
            `asset ${match[1]} did not serve as JS: ${contentType} ${body.slice(0, 120)}`,
          ),
        );
      }
    }).pipe(
      Effect.retry({
        schedule: Schedule.min([
          Schedule.exponential("500 millis", 1.5),
          Schedule.spaced("5 seconds"),
        ]),
        times: 30,
      }),
    );
  });

const waitForBucketToBeDeleted = Effect.fn(function* (
  bucketName: string,
  accountId: string,
) {
  yield* r2
    .getBucket({
      accountId,
      bucketName,
    })
    .pipe(
      Effect.flatMap(() => Effect.fail(new BucketStillExists())),
      Effect.retry({
        while: (e): e is BucketStillExists => e instanceof BucketStillExists,
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("200 millis"),
            Schedule.spaced("2 seconds"),
          ]),
          Schedule.recurs(20),
        ]),
      }),
      Effect.catchTag("NoSuchBucket", () => Effect.void),
    );
});

class BucketStillExists extends Data.TaggedError("BucketStillExists") {}
