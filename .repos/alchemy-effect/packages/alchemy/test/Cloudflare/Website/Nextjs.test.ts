import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectUrlContains } from "../Utils/Http.ts";
import { prepareNextjsFixture } from "./TypeScriptCompat.ts";
import {
  expectWorkerExists,
  waitForWorkerToBeDeleted,
} from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "nextjs-app");

const nextjsProps = (rootDir: string) => ({
  rootDir,
  workersDev: { enabled: true, previewsEnabled: true },
  memo: {
    include: [
      "app/**",
      "pages/**",
      "public/**",
      "package.json",
      "tsconfig.json",
      "middleware.ts",
      "next.config.mjs",
      "open-next.config.ts",
    ],
  },
});

const fetchJsonReady = <T>(url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        Effect.flatMap(res.text, (body) =>
          res.status === 200
            ? Effect.try({
                try: () => JSON.parse(body) as T,
                catch: () => new Error(`non-json body: ${body}`),
              })
            : Effect.fail(
                new Error(
                  `Worker not ready (${res.status}): ${body.slice(0, 300)}`,
                ),
              ),
        ),
      ),
      // Bounded: ~60s of edge propagation, then fail with the last body.
      Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
    );
  });

// Tests are independent (per-test scratch stacks, private fixture clones),
// so run them concurrently; suites are sequential by default.
describe.concurrent("Nextjs", () => {
  test.provider(
    "Nextjs: deploys SSR + binding + static assets, serves prerendered ISR, and memoizes unchanged rebuilds",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        // Clone outside the repo so Next does not treat the alchemy
        // monorepo as the workspace root (that lookup hits typescript 7
        // / tsgo, which has no `lib/typescript.js`).
        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nextjs-",
          entries: [
            "package.json",
            "tsconfig.json",
            "next.config.mjs",
            "open-next.config.ts",
            "middleware.ts",
            "app",
            "pages",
            "public",
          ],
        });
        yield* prepareNextjsFixture(rootDir);

        const bindingMarker = "nextjs-binding-marker";

        const deploy = () =>
          stack.deploy(
            Effect.gen(function* () {
              const kv = yield* Cloudflare.KV.Namespace("NextjsFixtureKv");
              return yield* Cloudflare.Website.Nextjs("NextjsSite", {
                ...nextjsProps(rootDir),
                env: {
                  TEST_TEXT: bindingMarker,
                  FIXTURE_KV: kv,
                },
              });
            }),
          );

        const site1 = yield* deploy();

        expect(site1.url).toBeDefined();
        expect(site1.hash?.input).toBeDefined();
        yield* expectWorkerExists(site1.workerName, accountId);

        // Dynamic (force-dynamic) app-router page rendered by the Worker.
        yield* expectUrlContains(`${site1.url!}/`, "NEXTJS_SSR_MARKER", {
          timeout: "120 seconds",
          label: "nextjs SSR home page",
        });

        // API route handler — the middleware matcher covers /api/*, so the
        // pass-through header also proves middleware executes on deploy.
        const client = yield* HttpClient.HttpClient;
        const helloRes = yield* client
          .get(`${site1.url!}/api/hello`)
          .pipe(
            Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
          );
        expect(helloRes.status).toBe(200);
        expect(helloRes.headers["x-fixture-middleware"]).toBe("passed");
        const hello = (yield* helloRes.json) as { hello: string };
        expect(hello.hello).toBe("world");

        // Middleware rewrite: /mw-rewrite serves the API route's response.
        const rewritten = yield* fetchJsonReady<{ hello: string }>(
          `${site1.url!}/mw-rewrite`,
        );
        expect(rewritten.hello).toBe("world");

        // Binding read through OpenNext's `getCloudflareContext()`.
        const binding = yield* fetchJsonReady<{ value: string | null }>(
          `${site1.url!}/api/binding`,
        );
        expect(binding.value).toBe(bindingMarker);

        // KV round-trip through a real resource binding: PUT then GET.
        const kvKey = `nextjs-live-${site1.hash?.input?.slice(0, 8)}`;
        const kvValue = `kv-value-${bindingMarker}`;
        const putRes = yield* client.execute(
          HttpClientRequest.put(`${site1.url!}/api/kv`).pipe(
            HttpClientRequest.bodyJsonUnsafe({ key: kvKey, value: kvValue }),
          ),
        );
        expect(putRes.status).toBe(200);
        const kvRead = yield* fetchJsonReady<{ value: string | null }>(
          `${site1.url!}/api/kv?key=${kvKey}`,
        );
        expect(kvRead.value).toBe(kvValue);

        // Static asset from `public/`.
        yield* expectUrlContains(
          `${site1.url!}/static.txt`,
          "NEXTJS_STATIC_ASSET_MARKER",
          {
            timeout: "60 seconds",
            label: "nextjs static asset",
          },
        );

        // ISR page: the prerendered payload serves (read-only static-assets
        // incremental cache; revalidation writes are a documented no-op).
        yield* expectUrlContains(`${site1.url!}/isr`, "NEXTJS_ISR_MARKER", {
          timeout: "60 seconds",
          label: "nextjs prerendered ISR page",
        });

        // Dynamic segment prerendered by generateStaticParams (SSG).
        yield* expectUrlContains(
          `${site1.url!}/products/alpha`,
          "product-slug:",
          {
            timeout: "60 seconds",
            label: "nextjs prerendered dynamic segment",
          },
        );
        // Non-prerendered slug renders on demand in the Worker.
        yield* expectUrlContains(
          `${site1.url!}/products/gamma`,
          "product-slug:",
          { timeout: "60 seconds", label: "nextjs on-demand dynamic segment" },
        );
        // Catch-all dynamic segment.
        yield* expectUrlContains(
          `${site1.url!}/docs/guides/deploy/workers`,
          "DOCS_CATCHALL_MARKER",
          { timeout: "60 seconds", label: "nextjs catch-all segment" },
        );

        // Streaming SSR through the real edge: the shell (with the Suspense
        // fallback) flushes before the slow segment resolves. identity
        // encoding keeps intermediate proxies from buffering the stream.
        const streamRes = yield* client.execute(
          HttpClientRequest.get(`${site1.url!}/streaming`).pipe(
            HttpClientRequest.setHeader("accept-encoding", "identity"),
          ),
        );
        expect(streamRes.status).toBe(200);
        const streamBody = yield* streamRes.text;
        expect(streamBody).toContain("STREAMING_SUSPENSE_MARKER");
        expect(streamBody).toContain("STREAMING_RESOLVED_MARKER");

        // Custom not-found boundary: unmatched routes and notFound() calls
        // both serve the custom 404 content with a 404 status. A colo that
        // hasn't picked up the deployment yet serves Cloudflare's platform
        // "Page not found" (also a 404), so retry until the response is the
        // app's own boundary rather than asserting the first answer.
        const expectCustom404 = (url: string, label: string) =>
          client.get(url).pipe(
            Effect.flatMap((res) =>
              Effect.flatMap(res.text, (body) =>
                res.status === 404 && body.includes("CUSTOM_NOT_FOUND_MARKER")
                  ? Effect.void
                  : Effect.fail(
                      new Error(
                        `${label}: status=${res.status}, custom not-found marker absent`,
                      ),
                    ),
              ),
            ),
            Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
          );
        yield* expectCustom404(
          `${site1.url!}/definitely/not/a/route`,
          "unmatched route",
        );
        yield* expectCustom404(`${site1.url!}/gone`, "notFound() page");

        // next.config redirects / rewrites / headers. The fetch-backed
        // client follows the 308, so assert the redirect lands on the home
        // page's content — a broken redirect would 404 instead.
        yield* expectUrlContains(
          `${site1.url!}/old-home`,
          "NEXTJS_SSR_MARKER",
          {
            timeout: "60 seconds",
            label: "nextjs next.config redirect (followed to home)",
          },
        );
        const rewritten2 = yield* fetchJsonReady<{ hello: string }>(
          `${site1.url!}/rewritten-hello`,
        );
        expect(rewritten2.hello).toBe("world");
        const headered = yield* client.get(`${site1.url!}/api/hello`);
        expect(headered.headers["x-fixture-config-header"]).toBe(
          "from-next-config",
        );

        // next/image (unoptimized): the page renders the img and the raw
        // asset serves through the ASSETS binding. Real optimization needs
        // a zone with Cloudflare Images — documented on the resource.
        yield* expectUrlContains(`${site1.url!}/image`, "IMAGE_PAGE_MARKER", {
          timeout: "60 seconds",
          label: "nextjs next/image page",
        });
        const pixel = yield* client.get(`${site1.url!}/pixel.png`);
        expect(pixel.status).toBe(200);
        expect(pixel.headers["content-type"]).toContain("image/png");

        // Pages Router page (getServerSideProps) + API route, coexisting
        // with the App Router.
        yield* expectUrlContains(
          `${site1.url!}/legacy`,
          "PAGES_ROUTER_MARKER",
          {
            timeout: "60 seconds",
            label: "nextjs pages-router page",
          },
        );
        const legacy = yield* fetchJsonReady<{ legacy: string }>(
          `${site1.url!}/api/legacy`,
        );
        expect(legacy.legacy).toBe("pages-api");

        // ── deploy 2: no changes ⇒ the rebuild-free input hash matches and
        // the deploy short-circuits without rebuilding ───────────────────────
        const site2 = yield* deploy();

        expect(site2.hash?.input).toBeDefined();
        expect(site2.hash?.input).toEqual(site1.hash?.input);
        expect(site2.url).toBe(site1.url);

        // ── deploy 3: edit the SSR page ⇒ the input hash changes and the
        // new content deploys ────────────────────────────────────────────────
        const pagePath = path.join(rootDir, "app/page.tsx");
        const page = yield* fs.readFileString(pagePath);
        yield* fs.writeFileString(
          pagePath,
          page.replace("NEXTJS_SSR_MARKER", "NEXTJS_SSR_MARKER_V2"),
        );

        const site3 = yield* deploy();

        expect(site3.hash?.input).toBeDefined();
        expect(site3.hash?.input).not.toEqual(site1.hash?.input);
        yield* expectUrlContains(`${site3.url!}/`, "NEXTJS_SSR_MARKER_V2", {
          timeout: "120 seconds",
          label: "nextjs SSR page after edit",
        });

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(site1.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 600_000 },
  );
});
