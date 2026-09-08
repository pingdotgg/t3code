import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import * as kv from "@distilled.cloud/cloudflare/kv";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectUrlContains, expectUrlRedirect } from "../Utils/Http.ts";
import {
  expectWorkerExists,
  waitForWorkerToBeDeleted,
} from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures/astro-app");
const staticFixtureDir = pathe.resolve(
  import.meta.dirname,
  "fixtures/astro-static-app",
);

// Keep the temp clone under the alchemy package so the project root stays
// within the workspace (same constraint as the Vite tests) and so the
// fixture's `astro` dependency resolves by walking up to
// `packages/alchemy/node_modules`.
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

class SessionFetchFailed extends Data.TaggedError("SessionFetchFailed")<{
  url: string;
  message: string;
}> {}

/**
 * Cookie-aware fetch for the session round-trip: returns the body plus
 * the `astro-session` cookie pair from `set-cookie` (if any).
 */
const fetchSession = (url: string, cookie?: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const u = new URL(url);
      u.searchParams.set("__alchemy_cb", String(Date.now()));
      const res = await fetch(u, {
        signal,
        cache: "no-store",
        headers: {
          "cache-control": "no-cache",
          accept: "*/*",
          ...(cookie ? { cookie } : {}),
        },
      });
      const body = await res.text();
      const sessionCookie = res.headers
        .get("set-cookie")
        ?.match(/astro-session=[^;,\s]+/)?.[0];
      return { status: res.status, body, sessionCookie };
    },
    catch: (e) =>
      new SessionFetchFailed({
        url,
        message: e instanceof Error ? e.message : String(e),
      }),
  });

class AstroResponseMismatch extends Data.TaggedError("AstroResponseMismatch")<{
  url: string;
  detail: string;
}> {
  override get message() {
    return `${this.url} :: ${this.detail}`;
  }
}

const responseRetry = Effect.retry({
  schedule: Schedule.min([
    Schedule.exponential("1 second", 1.5),
    Schedule.spaced("8 seconds"),
  ]),
  times: 8,
});

/**
 * Fetch the middleware-backed `/locals` page and assert the middleware ran
 * in the SAME request that rendered the page: the `x-middleware: hit`
 * header is present and the body renders the exact per-request id the
 * middleware mirrored onto `x-request-id`.
 */
const expectMiddlewareLocals = (url: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const u = new URL(url);
      u.searchParams.set("__alchemy_cb", String(Date.now()));
      const res = await fetch(u, {
        signal,
        cache: "no-store",
        headers: { "cache-control": "no-cache", accept: "*/*" },
      });
      return {
        status: res.status,
        body: await res.text(),
        middleware: res.headers.get("x-middleware"),
        requestId: res.headers.get("x-request-id"),
      };
    },
    catch: (e) =>
      new AstroResponseMismatch({
        url,
        detail: e instanceof Error ? e.message : String(e),
      }),
  }).pipe(
    Effect.filterOrFail(
      (r) =>
        r.status === 200 &&
        r.middleware === "hit" &&
        r.requestId !== null &&
        r.body.includes(`locals-request-id=${r.requestId}`),
      (r) =>
        new AstroResponseMismatch({
          url,
          detail: `${r.status} x-middleware=${r.middleware} x-request-id=${r.requestId} body=${r.body.slice(0, 200)}`,
        }),
    ),
    responseRetry,
  );

/**
 * Fetch a hashed asset and assert it serves 200 with the immutable
 * Cache-Control from the adapter-emitted `_headers`. Without the
 * provider folding `_headers` into the PUT asset config the asset
 * serves Cloudflare's default `public, max-age=0, must-revalidate`.
 */
const expectImmutableAsset = (assetUrl: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const u = new URL(assetUrl);
      u.searchParams.set("__alchemy_cb", String(Date.now()));
      const res = await fetch(u, {
        signal,
        cache: "no-store",
        headers: { "cache-control": "no-cache", accept: "*/*" },
      });
      await res.arrayBuffer();
      return {
        status: res.status,
        cacheControl: res.headers.get("cache-control"),
      };
    },
    catch: (e) =>
      new AstroResponseMismatch({
        url: assetUrl,
        detail: e instanceof Error ? e.message : String(e),
      }),
  }).pipe(
    Effect.filterOrFail(
      (r) =>
        r.status === 200 &&
        r.cacheControl === "public, max-age=31536000, immutable",
      (r) =>
        new AstroResponseMismatch({
          url: assetUrl,
          detail: `${r.status} cache-control: ${r.cacheControl}`,
        }),
    ),
    responseRetry,
  );

/** The exact payload `src/pages/api/binary.ts` serves. */
const BINARY_BYTES = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
];

/**
 * Fetch the binary endpoint and assert the exact bytes and content type
 * survive the round trip through the Worker.
 */
const expectBinaryEndpoint = (url: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const u = new URL(url);
      u.searchParams.set("__alchemy_cb", String(Date.now()));
      const res = await fetch(u, {
        signal,
        cache: "no-store",
        headers: { "cache-control": "no-cache", accept: "*/*" },
      });
      return {
        status: res.status,
        contentType: res.headers.get("content-type"),
        bytes: [...new Uint8Array(await res.arrayBuffer())],
      };
    },
    catch: (e) =>
      new AstroResponseMismatch({
        url,
        detail: e instanceof Error ? e.message : String(e),
      }),
  }).pipe(
    Effect.filterOrFail(
      (r) =>
        r.status === 200 &&
        r.contentType === "application/octet-stream" &&
        r.bytes.length === BINARY_BYTES.length &&
        r.bytes.every((b, i) => b === BINARY_BYTES[i]),
      (r) =>
        new AstroResponseMismatch({
          url,
          detail: `${r.status} ${r.contentType} bytes=[${r.bytes.join(",")}]`,
        }),
    ),
    responseRetry,
  );

/**
 * POST the urlencoded feedback form and assert the server-rendered echo —
 * pins that POSTs reach the Worker through the asset router.
 */
const expectFormPostEcho = (url: string, message: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const res = await fetch(url, {
        signal,
        method: "POST",
        cache: "no-store",
        body: new URLSearchParams({ message }),
        headers: { "cache-control": "no-cache", accept: "*/*" },
      });
      return { status: res.status, body: await res.text() };
    },
    catch: (e) =>
      new AstroResponseMismatch({
        url,
        detail: e instanceof Error ? e.message : String(e),
      }),
  }).pipe(
    Effect.filterOrFail(
      (r) => r.status === 200 && r.body.includes(`received: ${message}`),
      (r) =>
        new AstroResponseMismatch({
          url,
          detail: `${r.status} ${r.body.slice(0, 240)}`,
        }),
    ),
    responseRetry,
  );

/**
 * Round-trip a value through the fixture's `/api/kv` route (backed by the
 * user-declared `SITE_KV` binding): PUT then GET until the read observes
 * the write.
 */
const kvRoundTrip = (base: string, key: string, value: string) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: async (signal) => {
        const res = await fetch(
          `${base}/api/kv?key=${encodeURIComponent(key)}&value=${encodeURIComponent(value)}`,
          { signal, method: "PUT", cache: "no-store" },
        );
        return { status: res.status, body: await res.text() };
      },
      catch: (e) =>
        new AstroResponseMismatch({
          url: `${base}/api/kv`,
          detail: e instanceof Error ? e.message : String(e),
        }),
    }).pipe(
      Effect.filterOrFail(
        (r) => r.status === 200,
        (r) =>
          new AstroResponseMismatch({
            url: `${base}/api/kv`,
            detail: `PUT ${r.status} ${r.body.slice(0, 240)}`,
          }),
      ),
      responseRetry,
    );

    // Read back through the binding, retrying through KV read lag.
    yield* Effect.tryPromise({
      try: async (signal) => {
        const res = await fetch(
          `${base}/api/kv?key=${encodeURIComponent(key)}&__alchemy_cb=${Date.now()}`,
          { signal, cache: "no-store" },
        );
        return { status: res.status, body: await res.text() };
      },
      catch: (e) =>
        new AstroResponseMismatch({
          url: `${base}/api/kv`,
          detail: e instanceof Error ? e.message : String(e),
        }),
    }).pipe(
      Effect.filterOrFail(
        (r) => r.status === 200 && r.body.includes(`"value":"${value}"`),
        (r) =>
          new AstroResponseMismatch({
            url: `${base}/api/kv`,
            detail: `GET ${r.status} ${r.body.slice(0, 240)}`,
          }),
      ),
      responseRetry,
    );
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

// Tests are independent (per-test scratch stacks, private fixture clones),
// so run them concurrently; suites are sequential by default.
describe.concurrent("Astro", () => {
  test.provider(
    "Astro: SSR + env binding + prerender + static assets deploy; unchanged sources memo-skip the rebuild",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-astro-",
          tempRoot,
          entries: ["astro.config.mjs", "package.json", "public", "src"],
        });

        // Restrict the input memo to fixture sources so the test isn't
        // re-hashing the whole monorepo on every deploy. `workspaces: []`
        // pins the hash to the fixture alone: auto-detection would fold in
        // workspace-linked integration packages, whose trees can change
        // between deploys (concurrent development in this repo), breaking
        // the unchanged-rebuild memo assertion below. Workspace-aware
        // memoization has its own dedicated test in Vite.test.ts.
        const memo = {
          include: ["src/**", "public/**", "package.json", "astro.config.mjs"],
          workspaces: [],
        };

        // A random value is fine here — it is binding data, not a resource
        // name — and it stays constant across this test's deploys so the
        // metadata hash cannot mask a broken input-hash memo.
        const marker = `astro-marker-${Date.now()}`;

        const deploy = () =>
          stack.deploy(
            Effect.gen(function* () {
              // A REAL user-declared KV namespace bound through `env` —
              // distinct from the auto-provisioned session namespace. The
              // fixture's `/api/kv` route reads/writes it via the runtime env.
              const siteKv = yield* Cloudflare.KV.Namespace("SiteKV");
              const site = yield* Cloudflare.Website.Astro("AstroSite", {
                rootDir,
                workersDev: { enabled: true, previewsEnabled: true },
                // `nodejs_compat` deliberately omitted — the resource
                // auto-injects it, and this deploy proves that path.
                compatibility: { date: "2026-03-10" },
                memo,
                env: { TEST_MARKER: marker, SITE_KV: siteKv },
                assets: {
                  htmlHandling: "auto-trailing-slash",
                  notFoundHandling: "none",
                },
              });
              // Resource creation dedupes by logical id, so this returns the
              // session namespace the Astro resource auto-provisioned — a
              // handle for the out-of-band lifecycle assertions below.
              const sessions =
                yield* Cloudflare.KV.Namespace("AstroSiteSession");
              return { site, sessions, siteKv };
            }),
          );

        // ── deploy 1: build + serve ────────────────────────────────────────
        const { site: site1, sessions, siteKv } = yield* deploy();
        expect(site1.url).toBeDefined();
        expect(site1.hash?.input).toBeDefined();
        yield* expectWorkerExists(site1.workerName, accountId);

        // SSR page rendered in the Worker, reading the env binding.
        yield* expectUrlContains(`${site1.url!}/`, marker, {
          timeout: "120 seconds",
          label: "SSR page renders env binding",
        });
        // Prerendered page served from static assets. Keep the body — the
        // hashed-asset assertion below extracts the `/_astro/*.css` href.
        const aboutBody = yield* expectUrlContains(
          `${site1.url!}/about/`,
          "prerendered-page",
          {
            timeout: "60 seconds",
            label: "prerendered page",
          },
        );
        // Plain static asset from public/.
        yield* expectUrlContains(
          `${site1.url!}/static.txt`,
          "astro-static-asset",
          {
            timeout: "60 seconds",
            label: "static asset",
          },
        );

        // ── sessions: the SESSION KV namespace is auto-provisioned and
        // `Astro.session` round-trips through it ───────────────────────────
        expect(sessions.namespaceId).toBeDefined();
        const actualSessions = yield* kv.getNamespace({
          accountId,
          namespaceId: sessions.namespaceId,
        });
        expect(actualSessions.id).toEqual(sessions.namespaceId);

        // Wait for the route to serve before the cookie round-trip.
        yield* expectUrlContains(`${site1.url!}/session`, "session-count=", {
          timeout: "60 seconds",
          label: "session page",
        });

        // A single edge request can still 404 right after the readiness
        // probe above succeeded (workers.dev colo inconsistency) — retry
        // through it, bounded, before asserting on the body.
        const first = yield* fetchSession(`${site1.url!}/session`).pipe(
          Effect.filterOrFail(
            (res) => res.status === 200,
            (res) =>
              new SessionFetchFailed({
                url: `${site1.url!}/session`,
                message: `expected 200, got ${res.status}: ${res.body.slice(0, 240)}`,
              }),
          ),
          Effect.retry({
            schedule: Schedule.exponential("1 second", 1.5),
            times: 8,
          }),
        );
        expect(first.status).toBe(200);
        expect(first.body).toContain("session-count=1");
        expect(first.sessionCookie).toBeDefined();

        // Replaying the session cookie must observe the previous request's
        // KV write. Retry through KV's (brief, same-colo) read lag.
        const second = yield* fetchSession(
          `${site1.url!}/session`,
          first.sessionCookie,
        ).pipe(
          Effect.filterOrFail(
            (res) => res.body.includes("session-count=2"),
            (res) =>
              new SessionFetchFailed({
                url: `${site1.url!}/session`,
                message: `expected session-count=2, got: ${res.body.slice(0, 240)}`,
              }),
          ),
          Effect.retry({
            schedule: Schedule.exponential("1 second", 1.5),
            times: 8,
          }),
        );
        expect(second.body).toContain("session-count=2");

        // ── middleware: locals + response-header mutation ──────────────────
        yield* expectMiddlewareLocals(`${site1.url!}/locals`);

        // ── config redirects flow through `_redirects` to the asset layer ──
        yield* expectUrlRedirect(`${site1.url!}/old-about`, "/about/", {
          status: 301,
          timeout: "60 seconds",
          label: "config redirect via _redirects",
        });

        // ── binary endpoint returns the exact bytes ────────────────────────
        yield* expectBinaryEndpoint(`${site1.url!}/api/binary`);

        // ── urlencoded form POST reaches the Worker through the asset
        // router and re-renders with the echoed message ─────────────────────
        yield* expectFormPostEcho(`${site1.url!}/feedback`, marker);

        // ── user-declared KV binding: round-trip through the runtime env,
        // then verify out-of-band that the write landed in the REAL
        // namespace ────────────────────────────────────────────────────────
        expect(siteKv.namespaceId).toBeDefined();
        yield* kvRoundTrip(site1.url!, "astro-live-key", marker);
        const observed = yield* kv
          .getNamespaceValue({
            accountId,
            namespaceId: siteKv.namespaceId,
            keyName: "astro-live-key",
          })
          .pipe(
            Effect.flatMap((res) =>
              Effect.tryPromise(() =>
                new Response(
                  Stream.toReadableStream(res.body) as BodyInit,
                ).text(),
              ),
            ),
            Effect.retry({
              schedule: Schedule.exponential("1 second", 1.5),
              times: 8,
            }),
          );
        expect(observed).toBe(marker);

        // ── hashed `/_astro/*` asset serves with the immutable Cache-Control
        // from the adapter-emitted `_headers` — pins the WorkerProvider
        // folding a source build's `_headers`/`_redirects` into the PUT
        // asset config (source providers hash the files but don't pre-merge
        // them into `config`; only alchemy's own `readAssets` does). Without
        // that merge the asset serves Cloudflare's default
        // `public, max-age=0, must-revalidate`. ───────────────────────────
        const assetHref = aboutBody.match(/\/_astro\/[^"']+\.css/)?.[0];
        expect(assetHref).toBeDefined();
        const assetUrl = `${site1.url!}${assetHref!}`;
        yield* expectImmutableAsset(assetUrl);

        // ── deploy 2: nothing changed ⇒ memo hit (no rebuild) ──────────────
        const { site: site2 } = yield* deploy();
        expect(site2.hash?.input).toEqual(site1.hash?.input);
        expect(site2.hash?.bundle).toEqual(site1.hash?.bundle);
        expect(site2.hash?.assets).toEqual(site1.hash?.assets);

        // The no-op redeploy takes the provider's hash-matched KEEP path,
        // which rebuilds the asset config wholesale (no upload jwt). A
        // regression there would silently wipe the `_headers`/`_redirects`
        // rules on every no-op deploy — re-assert both still serve.
        yield* expectImmutableAsset(assetUrl);
        yield* expectUrlRedirect(`${site1.url!}/old-about`, "/about/", {
          status: 301,
          timeout: "60 seconds",
          label: "redirect after no-op keep-assets deploy",
        });

        // ── deploy 3: edit a page ⇒ memo busts, new content serves ─────────
        const indexPath = path.join(rootDir, "src/pages/index.astro");
        const source = yield* fs.readFileString(indexPath);
        yield* fs.writeFileString(
          indexPath,
          source.replace("Astro Fixture", "Astro Fixture Edited"),
        );

        const { site: site3 } = yield* deploy();
        expect(site3.hash?.input).toBeDefined();
        expect(site3.hash?.input).not.toEqual(site1.hash?.input);
        yield* expectUrlContains(`${site3.url!}/`, "Astro Fixture Edited", {
          timeout: "60 seconds",
          label: "edited SSR page",
        });

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(site1.workerName, accountId);

        // Destroy must also clean up the auto-provisioned session namespace
        // and the user-declared SITE_KV namespace.
        yield* waitForNamespaceToBeDeleted(sessions.namespaceId, accountId);
        yield* waitForNamespaceToBeDeleted(siteKv.namespaceId, accountId);
      }).pipe(logLevel),
    { timeout: 420_000 },
  );

  class NotFoundPageMismatch extends Data.TaggedError("NotFoundPageMismatch")<{
    url: string;
    actual: string;
  }> {}

  /**
   * Assert `url` answers a REAL `404` whose body contains `marker` — the
   * built `404.html` served by the asset layer (`notFoundHandling:
   * "404-page"`), not a worker-rendered page and not Cloudflare's
   * placeholder. Retries through edge propagation like `expectUrlContains`
   * (which can't be used here: it requires `res.ok`).
   */
  const expectNotFoundPage = (url: string, marker: string) =>
    Effect.tryPromise({
      try: async (signal) => {
        const u = new URL(url);
        u.searchParams.set("__alchemy_cb", String(Date.now()));
        const res = await fetch(u, {
          signal,
          cache: "no-store",
          headers: { "cache-control": "no-cache", accept: "*/*" },
        });
        const body = await res.text();
        return { status: res.status, body };
      },
      catch: (e) =>
        new NotFoundPageMismatch({
          url,
          actual: e instanceof Error ? e.message : String(e),
        }),
    }).pipe(
      Effect.filterOrFail(
        (res) => res.status === 404 && res.body.includes(marker),
        (res) =>
          new NotFoundPageMismatch({
            url,
            actual: `${res.status} ${res.body.slice(0, 240)}`,
          }),
      ),
      Effect.retry({
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("750 millis", 1.5),
            Schedule.spaced("8 seconds"),
          ]),
          Schedule.recurs(15),
        ]),
      }),
    );

  // ─────────────────────────────────────────────────────────────────────
  // Assets-only deploys (seam: SourceBuildOutput.bundle === undefined)
  //
  // A declared `output: "static"` project prerenders every page,
  // so the astro source's build produces NO server modules — the source
  // path must flow `bundle: undefined` into the WorkerProvider's
  // assets-only mode: the script PUT carries no modules and no main_module,
  // and Cloudflare's asset layer answers every request (including the built
  // 404.html via `errorPage: "404.html"`). Session auto-provisioning
  // is skipped — no Worker code could ever read the namespace.
  // ─────────────────────────────────────────────────────────────────────

  test.provider(
    "Astro: output 'static' deploys assets-only — no server bundle, 404.html from assets, memoized rebuilds",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(staticFixtureDir, {
          prefix: "alchemy-astro-static-",
          tempRoot,
          entries: ["package.json", "public", "src"],
        });

        // Same discipline as the SSR test above: pin the input hash to the
        // fixture so concurrent development in this repo can't bust the
        // unchanged-rebuild memo assertion.
        const memo = {
          include: ["src/**", "public/**", "package.json"],
          workspaces: [],
        };

        const deploy = () =>
          stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Website.Astro("AstroStaticSite", {
                rootDir,
                workersDev: { enabled: true, previewsEnabled: true },
                compatibility: { date: "2026-03-10" },
                memo,
                astro: { output: "static" },
                assets: { notFoundHandling: "404-page" },
              });
            }),
          );

        // ── deploy 1: build + assets-only serve ────────────────────────────
        const site1 = yield* deploy();
        expect(site1.url).toBeDefined();
        expect(site1.hash?.input).toBeDefined();
        expect(site1.hash?.assets).toBeDefined();
        // The contract under test: no server bundle was produced or
        // uploaded — the bundle hash slot stays empty.
        expect(site1.hash?.bundle).toBeUndefined();
        yield* expectWorkerExists(site1.workerName, accountId);

        // Every page serves from the asset layer.
        yield* expectUrlContains(`${site1.url!}/`, "static-home", {
          timeout: "120 seconds",
          label: "static home page",
        });
        yield* expectUrlContains(`${site1.url!}/about/`, "static-about", {
          timeout: "60 seconds",
          label: "static about page",
        });
        yield* expectUrlContains(
          `${site1.url!}/static.txt`,
          "astro-static-public-asset",
          {
            timeout: "60 seconds",
            label: "public asset",
          },
        );

        // Unknown routes get the BUILT 404.html with a real 404 status —
        // Cloudflare's asset layer applies `notFoundHandling` itself; no
        // Worker script is involved.
        yield* expectNotFoundPage(
          `${site1.url!}/definitely-not-a-page`,
          "static-404",
        );

        // Session auto-provisioning is skipped for declared-static sites:
        // no KV namespace titled for this stack's session id may exist.
        // (Physical titles embed the logical id verbatim:
        // `{stack}-AstroStaticSiteSession-{stage}-{suffix}`.)
        const sessionNamespace = yield* kv.listNamespaces
          .items({ accountId })
          .pipe(
            Stream.filter((ns) => ns.title.includes("AstroStaticSiteSession")),
            Stream.runHead,
            Effect.map(Option.getOrUndefined),
          );
        expect(sessionNamespace).toBeUndefined();

        // ── deploy 2: nothing changed ⇒ memo hit, still assets-only ────────
        const site2 = yield* deploy();
        expect(site2.hash?.input).toEqual(site1.hash?.input);
        expect(site2.hash?.assets).toEqual(site1.hash?.assets);
        expect(site2.hash?.bundle).toBeUndefined();
        expect(site2.url).toBe(site1.url);

        // ── deploy 3: edit a page ⇒ memo busts, new content serves,
        // and the deploy REMAINS assets-only ───────────────────────────────
        const indexPath = path.join(rootDir, "src/pages/index.astro");
        const source = yield* fs.readFileString(indexPath);
        yield* fs.writeFileString(
          indexPath,
          source.replace("static-home", "static-home-v2"),
        );

        const site3 = yield* deploy();
        expect(site3.hash?.input).toBeDefined();
        expect(site3.hash?.input).not.toEqual(site1.hash?.input);
        expect(site3.hash?.bundle).toBeUndefined();
        yield* expectUrlContains(`${site3.url!}/`, "static-home-v2", {
          timeout: "60 seconds",
          label: "edited static home page",
        });

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(site1.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );

  // ─────────────────────────────────────────────────────────────────────
  // SPA fallback: `assets.notFoundHandling: "single-page-application"`
  //
  // A client-routed static build: every real page is a prerendered asset,
  // and a hard GET to any UNREGISTERED route must serve the app shell
  // (`/index.html`) with a 200 so the client router can boot. The built
  // `404.html` must NOT serve — SPA handling supersedes the 404 page.
  // ─────────────────────────────────────────────────────────────────────

  test.provider(
    "Astro: SPA not-found handling serves the app shell for deep links",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const rootDir = yield* cloneFixture(staticFixtureDir, {
          prefix: "alchemy-astro-spa-",
          tempRoot,
          entries: ["package.json", "public", "src"],
        });

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.Astro("AstroSpaSite", {
              rootDir,
              workersDev: { enabled: true, previewsEnabled: true },
              compatibility: { date: "2026-03-10" },
              memo: {
                include: ["src/**", "public/**", "package.json"],
                workspaces: [],
              },
              astro: { output: "static" },
              assets: { notFoundHandling: "single-page-application" },
            });
          }),
        );

        expect(site.url).toBeDefined();
        // Fully-static SPA deploy: assets only, no server bundle.
        expect(site.hash?.bundle).toBeUndefined();
        yield* expectWorkerExists(site.workerName, accountId);

        // The app shell itself serves at `/`.
        yield* expectUrlContains(`${site.url!}/`, "static-home", {
          timeout: "120 seconds",
          label: "SPA shell at /",
        });

        // (a) A hard GET to a route that was never registered serves the
        // shell (`index.html`) with a 200 — `expectUrlContains` requires
        // `res.ok`, so a 404 status can't satisfy this. The built
        // `404.html` must NOT leak through.
        const deepLinkBody = yield* expectUrlContains(
          `${site.url!}/spa/definitely/not/a/route`,
          "static-home",
          {
            timeout: "60 seconds",
            label: "deep link serves SPA shell",
          },
        );
        expect(deepLinkBody).not.toContain("static-404");

        // (b) A real prerendered page still serves its own content, not
        // the shell.
        const aboutBody = yield* expectUrlContains(
          `${site.url!}/about/`,
          "static-about",
          {
            timeout: "60 seconds",
            label: "real page still serves",
          },
        );
        expect(aboutBody).not.toContain("static-home");

        // (c) A real static asset still serves normally.
        yield* expectUrlContains(
          `${site.url!}/static.txt`,
          "astro-static-public-asset",
          {
            timeout: "60 seconds",
            label: "static asset with SPA handling",
          },
        );

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(site.workerName, accountId);
      }).pipe(logLevel),
    { timeout: 360_000 },
  );
});
