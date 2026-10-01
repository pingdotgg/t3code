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

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "octane-app");

// Keep the temp clone under the alchemy package (same convention as the
// Vite tests) so the project root stays representable relative to cwd —
// and so `octane`/`@octanejs/*` resolve from the workspace's hoisted
// node_modules when the fixture's own tree has none.
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const fixtureEntries = [
  ".gitignore",
  "package.json",
  "octane.config.ts",
  "vite.config.ts",
  "index.html",
  "src",
  "public",
];

const memoInclude = [
  "src/**",
  "public/**",
  "index.html",
  "octane.config.ts",
  "vite.config.ts",
  "package.json",
];

const octaneProps = (rootDir: string) => ({
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
describe.concurrent("Octane", () => {
  test.provider(
    "Octane: deploys SSR + bindings + static assets and memoizes unchanged rebuilds",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-octane-",
          tempRoot,
          entries: fixtureEntries,
        });

        const bindingMarker = "octane-binding-marker";

        const deploy = () =>
          stack.deploy(
            Effect.gen(function* () {
              const siteKv = yield* Cloudflare.KV.Namespace("SiteKV");
              const site = yield* Cloudflare.Website.Octane("OctaneSite", {
                ...octaneProps(rootDir),
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

        // SSR page: the adapter-emitted worker renders on asset miss.
        yield* expectUrlContains(`${site1.url!}/`, "OCTANE_PAGE_MARKER", {
          timeout: "120 seconds",
          label: "SSR home page",
        });

        // Server route: reads `context.platform` — the adapter-forwarded
        // `{ env, ctx }` pair — proving bindings reach Octane's runtime
        // contract.
        const hello = yield* fetchJsonReady<{
          marker: string;
          binding: string | null;
          hasWaitUntil: boolean;
        }>(`${site1.url!}/api/hello`);
        expect(hello.marker).toBe("api-route-ok");
        expect(hello.binding).toBe(bindingMarker);
        expect(hello.hasWaitUntil).toBe(true);

        // KV binding: the worker's PUT lands in the real namespace and the
        // worker's GET reads it back through the native binding.
        const kvKey = "octane-live-key";
        const kvValue = "octane-live-value";
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

        // Static asset from `public/`, served asset-first.
        yield* expectUrlContains(`${site1.url!}/robots.txt`, "User-agent", {
          timeout: "60 seconds",
          label: "static asset",
        });

        // ── deploy 2: no changes ⇒ the rebuild-free input hash matches and
        // the deploy short-circuits without building ─────────────────────────
        const { site: site2 } = yield* deploy();

        expect(site2.hash?.input).toBeDefined();
        expect(site2.hash?.input).toEqual(site1.hash?.input);
        expect(site2.url).toBe(site1.url);

        // ── deploy 3: edit the page ⇒ the input hash changes and the new
        // content deploys. The edited marker is asserted on the *dynamic*
        // SSR page (worker-rendered per request) — a changed static asset at
        // the same URL can stay stale at a PoP far longer than a
        // worker-version flip ────────────────────────────────────────────────
        const appPath = path.join(rootDir, "src/App.tsx");
        const app = yield* fs.readFileString(appPath);
        yield* fs.writeFileString(
          appPath,
          app.replace("OCTANE_PAGE_MARKER", "OCTANE_PAGE_MARKER_V2"),
        );

        const { site: site3 } = yield* deploy();

        expect(site3.hash?.input).toBeDefined();
        expect(site3.hash?.input).not.toEqual(site1.hash?.input);
        yield* expectUrlContains(`${site3.url!}/`, "OCTANE_PAGE_MARKER_V2", {
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
});

/**
 * GET `url` until it answers 200 with a JSON body (fresh workers.dev URLs
 * take a few seconds to start serving). Mirrors Nuxt.test.ts's helper of
 * the same name.
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
        // Capped interval, ~90s total budget (workers.dev / DO propagation).
        schedule: Schedule.min([
          Schedule.exponential("500 millis"),
          Schedule.spaced("2 seconds"),
        ]),
        times: 45,
      }),
    );
  });

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
