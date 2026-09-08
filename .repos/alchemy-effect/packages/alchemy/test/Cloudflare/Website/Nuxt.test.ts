import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import * as kv from "@distilled.cloud/cloudflare/kv";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
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

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "nuxt-app");

// Keep the temp clone under the alchemy package (same convention as the
// Vite tests) so the project root stays representable relative to cwd —
// and so `nuxt`/`nitropack` resolve from the workspace's hoisted
// node_modules when the fixture's own tree has none.
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const fixtureEntries = [
  ".gitignore",
  "package.json",
  "nuxt.config.ts",
  "worker-entry.ts",
  "app",
  "server",
  "public",
];

const memoInclude = [
  "app/**",
  "server/**",
  "public/**",
  "nuxt.config.ts",
  "worker-entry.ts",
  "package.json",
];

const nuxtProps = (rootDir: string) => ({
  rootDir,
  workersDev: { enabled: true, previewsEnabled: true },
  memo: {
    include: memoInclude,
  },
});

class NamespaceStillExists extends Data.TaggedError("NamespaceStillExists") {}

const waitForNamespaceToBeDeleted = Effect.fn(function* (
  namespaceId: string,
  accountId: string,
) {
  yield* kv.getNamespace({ accountId, namespaceId }).pipe(
    Effect.flatMap(() => Effect.fail(new NamespaceStillExists())),
    Effect.retry({
      while: (e): e is NamespaceStillExists =>
        e instanceof NamespaceStillExists,
      schedule: Schedule.min([
        Schedule.exponential(250),
        Schedule.spaced("2 seconds"),
      ]),
      times: 10,
    }),
    Effect.catchTag("NamespaceNotFound", () => Effect.void),
  );
});

/**
 * Read `keyName` from the real cloud namespace via distilled's KV API,
 * retrying through KV's brief read-after-write lag while the key is not
 * yet visible.
 */
const readNamespaceValue = Effect.fn(function* (options: {
  accountId: string;
  namespaceId: string;
  keyName: string;
}) {
  const res = yield* kv.getNamespaceValue(options).pipe(
    Effect.retry({
      while: (e): boolean => e._tag === "KeyNotFound",
      schedule: Schedule.min([
        Schedule.exponential("1 second"),
        Schedule.spaced("3 seconds"),
      ]),
      times: 8,
    }),
  );
  return yield* Effect.tryPromise(() =>
    new Response(Stream.toReadableStream(res.body) as BodyInit).text(),
  );
});

// Tests are independent (per-test scratch stacks, private fixture clones),
// so run them concurrently; suites are sequential by default.
describe.concurrent("Nuxt", () => {
  test.provider(
    "Nuxt: deploys SSR + bindings + static assets and memoizes unchanged rebuilds",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nuxt-",
          tempRoot,
          entries: fixtureEntries,
        });

        const bindingMarker = "nuxt-binding-marker";

        const deploy = () =>
          stack.deploy(
            Effect.gen(function* () {
              const siteKv = yield* Cloudflare.KV.Namespace("SiteKV");
              const site = yield* Cloudflare.Website.Nuxt("NuxtSite", {
                ...nuxtProps(rootDir),
                env: {
                  TEST_BINDING: bindingMarker,
                  SITE_KV: siteKv,
                },
              });
              return { site, siteKv };
            }),
          );

        const { site: site1, siteKv } = yield* deploy();

        expect(site1.url).toBeDefined();
        expect(site1.hash?.input).toBeDefined();
        yield* expectWorkerExists(site1.workerName, accountId);

        // SSR page: rendered by the Worker at request time.
        yield* expectUrlContains(`${site1.url!}/`, "NUXT_PAGE_MARKER", {
          timeout: "120 seconds",
          label: "SSR home page",
        });

        // The SSR page reads `event.context.cloudflare.env.TEST_BINDING` —
        // proves bindings reach nitro's cloudflare_module runtime contract.
        yield* expectUrlContains(`${site1.url!}/`, `binding:${bindingMarker}`, {
          timeout: "60 seconds",
          label: "SSR page with event.context.cloudflare.env binding",
        });

        // The fixture's own nuxt.config.ts loaded natively — its
        // `runtimeConfig.public.fixtureMarker` renders on the page.
        yield* expectUrlContains(
          `${site1.url!}/`,
          "config:nuxt-user-config-loaded",
          {
            timeout: "60 seconds",
            label: "user nuxt.config.ts applied",
          },
        );

        // API route: reads the binding + waitUntil from the runtime contract.
        const hello = yield* fetchJsonReady<{
          marker: string;
          binding: string | null;
          hasWaitUntil: boolean;
        }>(`${site1.url!}/api/hello`);
        expect(hello.marker).toBe("api-route-ok");
        expect(hello.binding).toBe(bindingMarker);
        expect(hello.hasWaitUntil).toBe(true);

        // POST route: the JSON body flows through h3's readBody and comes
        // back verbatim, with the binding visible on a non-GET route.
        const echoPayload = { message: "hello-from-post", n: 42 };
        const echo = yield* postJsonReady<{
          method: string;
          echoed: { message: string; n: number };
          binding: string | null;
        }>(`${site1.url!}/api/echo`, echoPayload);
        expect(echo.method).toBe("POST");
        expect(echo.echoed).toEqual(echoPayload);
        expect(echo.binding).toBe(bindingMarker);

        // KV binding: the worker's PUT lands in the real namespace and the
        // worker's GET reads it back through the native binding.
        const kvKey = "nuxt-live-key";
        const kvValue = "nuxt-live-value";
        expect(siteKv.namespaceId).toBeDefined();
        const put = yield* putJsonReady<{ put: boolean; key: string }>(
          `${site1.url!}/api/kv?key=${kvKey}&value=${kvValue}`,
        );
        expect(put.put).toBe(true);
        const got = yield* fetchJsonReady<{
          key: string;
          value: string | null;
        }>(`${site1.url!}/api/kv?key=${kvKey}`);
        expect(got.value).toBe(kvValue);

        // Out-of-band: the write is visible through the cloud KV API — the
        // binding really targeted the namespace this stack provisioned.
        const observed = yield* readNamespaceValue({
          accountId,
          namespaceId: siteKv.namespaceId,
          keyName: kvKey,
        });
        expect(observed).toBe(kvValue);

        // Static asset from `public/`.
        yield* expectUrlContains(`${site1.url!}/robots.txt`, "User-agent", {
          timeout: "60 seconds",
          label: "static asset",
        });

        // Route-rule prerendered page, served from assets.
        yield* expectUrlContains(
          `${site1.url!}/prerendered`,
          "this-page-is-prerendered",
          {
            timeout: "60 seconds",
            label: "prerendered page",
          },
        );

        // ── deploy 2: no changes ⇒ the rebuild-free input hash matches and
        // the deploy short-circuits without building ─────────────────────────
        const { site: site2 } = yield* deploy();

        expect(site2.hash?.input).toBeDefined();
        expect(site2.hash?.input).toEqual(site1.hash?.input);
        expect(site2.url).toBe(site1.url);

        // ── deploy 3: edit a page ⇒ the input hash changes and the new
        // content deploys. The edited marker is asserted on the *dynamic*
        // page (worker-rendered per request) — a changed static asset at the
        // same URL can stay stale at a PoP far longer than a worker-version
        // flip ─────────────────────────────────────────────────────────────
        const indexPath = path.join(rootDir, "app/pages/index.vue");
        const index = yield* fs.readFileString(indexPath);
        yield* fs.writeFileString(
          indexPath,
          index.replace("NUXT_PAGE_MARKER", "NUXT_PAGE_MARKER_V2"),
        );

        const { site: site3 } = yield* deploy();

        expect(site3.hash?.input).toBeDefined();
        expect(site3.hash?.input).not.toEqual(site1.hash?.input);
        yield* expectUrlContains(`${site3.url!}/`, "NUXT_PAGE_MARKER_V2", {
          timeout: "180 seconds",
          label: "SSR page after edit",
        });

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(site1.workerName, accountId);

        // Destroy must also delete the stack-provisioned KV namespace.
        yield* waitForNamespaceToBeDeleted(siteKv.namespaceId, accountId);
      }).pipe(logLevel),
    { timeout: 600_000 },
  );

  // ─────────────────────────────────────────────────────────────────────
  // Custom worker entry (seam: NuxtProps.main → nitro.options.entry)
  //
  // `main` points the deploy at the user's own module, which wraps nitro's
  // emitted cloudflare-module handler (imported from
  // `nitropack/presets/cloudflare/runtime/cloudflare-module`) and re-exports
  // the `Counter` Durable Object class — DO classes must live on the
  // deployed worker for their namespace bindings to resolve. Mirrors
  // Waku.test.ts's "main deploys a custom worker entry" test.
  // ─────────────────────────────────────────────────────────────────────

  test.provider(
    "Nuxt: main deploys a custom worker entry hosting a Durable Object",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-nuxt-main-",
          tempRoot,
          entries: fixtureEntries,
        });

        const bindingMarker = "nuxt-main-marker";

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.Nuxt("NuxtMainSite", {
              ...nuxtProps(rootDir),
              // The user's own worker entry: wraps nitro's handler and
              // exports the Counter DO.
              main: "worker-entry.ts",
              env: {
                TEST_BINDING: bindingMarker,
                COUNTER: Cloudflare.DurableObject("Counter", {
                  className: "Counter",
                }),
              },
            });
          }),
        );

        expect(site.url).toBeDefined();
        yield* expectWorkerExists(site.workerName, accountId);

        // The DO namespace is bound and state increments ACROSS requests —
        // instance identity on the deployed worker, through the custom entry.
        // (POST increments, GET reads — see server/api/counter.ts.)
        const first = yield* postJsonReady<{ count: number }>(
          `${site.url!}/api/counter`,
          {},
        );
        const second = yield* postJsonReady<{ count: number }>(
          `${site.url!}/api/counter`,
          {},
        );
        expect(second.count).toBe(first.count + 1);

        const read = yield* fetchJsonReady<{ count: number }>(
          `${site.url!}/api/counter`,
        );
        expect(read.count).toBe(second.count);

        // Wrapping nitro's handler keeps every framework route working:
        // the SSR page still renders (and still reads bindings).
        yield* expectUrlContains(`${site.url!}/`, "NUXT_PAGE_MARKER", {
          timeout: "120 seconds",
          label: "SSR page through the custom entry",
        });
        yield* expectUrlContains(`${site.url!}/`, `binding:${bindingMarker}`, {
          timeout: "60 seconds",
          label: "env binding through the custom entry",
        });

        // API route through the wrapped handler.
        const hello = yield* fetchJsonReady<{
          marker: string;
          binding: string | null;
        }>(`${site.url!}/api/hello`);
        expect(hello.marker).toBe("api-route-ok");
        expect(hello.binding).toBe(bindingMarker);

        // Static asset + prerendered page still serve from assets alongside
        // the custom entry.
        yield* expectUrlContains(`${site.url!}/robots.txt`, "User-agent", {
          timeout: "60 seconds",
          label: "static asset with custom entry",
        });
        yield* expectUrlContains(
          `${site.url!}/prerendered`,
          "this-page-is-prerendered",
          {
            timeout: "60 seconds",
            label: "prerendered page with custom entry",
          },
        );

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(site.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 600_000 },
  );

  // ─────────────────────────────────────────────────────────────────────
  // SPA mode: `ssr: false`
  //
  // Pages render exclusively in the browser — the raw HTML the deploy
  // serves is the app shell (identified by the fixture's `app.head` meta
  // marker), for `/` and for deep links alike. Nitro keeps `server/`
  // routes executing in the worker with the full cloudflare runtime
  // contract; only page rendering moves to the client.
  // ─────────────────────────────────────────────────────────────────────

  const spaFixtureDir = pathe.resolve(
    import.meta.dirname,
    "fixtures",
    "nuxt-spa-app",
  );

  const SPA_SHELL_MARKER = "nuxt-spa-shell";

  test.provider(
    "Nuxt: ssr:false serves the SPA shell while server routes still run in the worker",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(spaFixtureDir, {
          prefix: "alchemy-nuxt-spa-",
          tempRoot,
          entries: [
            ".gitignore",
            "package.json",
            "nuxt.config.ts",
            "app",
            "server",
            "public",
          ],
        });

        const bindingMarker = "nuxt-spa-binding-marker";

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.Nuxt("NuxtSpaSite", {
              rootDir,
              workersDev: { enabled: true, previewsEnabled: true },
              memo: {
                include: [
                  "app/**",
                  "server/**",
                  "public/**",
                  "nuxt.config.ts",
                  "package.json",
                ],
              },
              env: {
                TEST_BINDING: bindingMarker,
              },
            });
          }),
        );

        expect(site.url).toBeDefined();
        yield* expectWorkerExists(site.workerName, accountId);

        // (a) `/` serves the app shell: the `app.head` meta marker is in
        // the raw HTML, while the page markup (which only ever renders in
        // the browser under `ssr: false`) is absent.
        const homeBody = yield* expectUrlContains(
          `${site.url!}/`,
          SPA_SHELL_MARKER,
          {
            timeout: "120 seconds",
            label: "SPA shell at /",
          },
        );
        expect(homeBody).not.toContain("NUXT_SPA_PAGE_MARKER");

        // (b) A hard GET to a client route serves the shell too — the
        // client router owns the route; its markup never appears in HTML.
        const deepBody = yield* expectUrlContains(
          `${site.url!}/deep`,
          SPA_SHELL_MARKER,
          {
            timeout: "60 seconds",
            label: "deep link serves SPA shell",
          },
        );
        expect(deepBody).not.toContain("NUXT_SPA_DEEP_MARKER");

        // (c) Nitro keeps `server/api` routes executing in the worker,
        // `ssr: false` notwithstanding — with the cloudflare_module
        // runtime contract (env binding + waitUntil) intact.
        const hello = yield* fetchJsonReady<{
          marker: string;
          binding: string | null;
          hasWaitUntil: boolean;
        }>(`${site.url!}/api/hello`);
        expect(hello.marker).toBe("spa-api-route-ok");
        expect(hello.binding).toBe(bindingMarker);
        expect(hello.hasWaitUntil).toBe(true);

        // (d) A `public/` asset serves from the asset layer.
        yield* expectUrlContains(`${site.url!}/robots.txt`, "User-agent", {
          timeout: "60 seconds",
          label: "static asset in SPA mode",
        });

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(site.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 600_000 },
  );
});

/**
 * GET `url` until it answers 200 with a JSON body (fresh workers.dev URLs
 * take a few seconds to start serving). Mirrors SvelteKit.test.ts's
 * helper of the same name.
 */
const fetchJsonReady = <T>(url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
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
        // Capped interval, ~90s total budget: fresh workers.dev subdomains and
        // DO namespaces can take over a minute to start serving under
        // concurrent deploys.
        schedule: Schedule.min([
          Schedule.exponential("500 millis"),
          Schedule.spaced("2 seconds"),
        ]),
        times: 45,
      }),
    );
  });

/** POST a JSON body to `url` until it answers 200 with a JSON body. */
const postJsonReady = <T>(url: string, body: unknown) =>
  HttpClient.execute(
    HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
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

/** PUT (empty body) to `url` until it answers 200 with a JSON body. */
const putJsonReady = <T>(url: string) =>
  HttpClient.execute(HttpClientRequest.put(url)).pipe(
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
