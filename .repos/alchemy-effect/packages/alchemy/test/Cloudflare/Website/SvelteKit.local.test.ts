import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import { isLocalId } from "@/Cloudflare/LocalRuntime.ts";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import * as kv from "@distilled.cloud/cloudflare/kv";
import { describe, expect } from "alchemy-test";
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

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "fixtures",
  "sveltekit-app",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

/**
 * PUT a text body to `url`, retrying until the dev server serves 200.
 * Kit's CSRF protection 403s form-like content types (`text/plain`
 * included) on non-GET requests unless the `origin` header matches the
 * site, so the site origin is sent explicitly.
 */
const putTextReady = (url: string, body: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    yield* client
      .execute(
        HttpClientRequest.put(url).pipe(
          HttpClientRequest.setHeaders({ origin: new URL(url).origin }),
          HttpClientRequest.bodyText(body, "text/plain"),
        ),
      )
      .pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? Effect.void
            : Effect.fail(new Error(`PUT not ready: ${res.status}`)),
        ),
        Effect.retry({
          schedule: Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("4 seconds"),
          ]),
          times: 15,
        }),
      );
  });

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
          : Effect.fail(new Error(`dev server not ready: ${res.status}`)),
      ),
      Effect.retry({
        schedule: Schedule.min([
          Schedule.exponential("500 millis"),
          Schedule.spaced("4 seconds"),
        ]),
        times: 15,
      }),
    );
  });

// Concurrent like the other Website suites: the kit dev server never
// chdirs (the kit-runtime realign plugin handles cwd != root), so
// nothing here mutates process-global state.
describe.concurrent("SvelteKit dev", () => {
  test.provider(
    "SvelteKit dev: local dev server renders SSR with platform.env bindings, local KV, and HMR",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-sveltekit-dev-",
          tempRoot,
          entries: ["package.json", "src", "static"],
        });

        const bindingMarker = "sveltekit-dev-binding-marker";

        const { site, siteKv } = yield* stack.deploy(
          Effect.gen(function* () {
            // A locally-emulated KV namespace bound into `platform.env` —
            // no cloud call runs for it in dev.
            const siteKv = yield* Cloudflare.KV.Namespace("SiteKV");
            const site = yield* Cloudflare.Website.SvelteKit("SvelteKitLocal", {
              rootDir,
              dev: { port: 0 },
              memo: { include: ["src/**", "static/**", "package.json"] },
              env: {
                TEST_BINDING: bindingMarker,
                SITE_KV: siteKv,
              },
            });
            return { site, siteKv };
          }),
        );

        // Local identity: the url points at the alchemy dev proxy — no
        // cloud Worker exists — and the namespace id carries the `dev:`
        // marker (proof no cloud call ran for it).
        expect(site.url).toBeDefined();
        expect(site.url).toMatch(/^http:\/\/localhost:\d+/);
        expect(isLocalId(siteKv.namespaceId)).toBe(true);
        expect(siteKv.namespaceId).toMatch(/^dev:/);

        // SSR route: kit's own Vite dev server (Node SSR), with
        // `platform.env` served by the cloudflare-runtime platform proxy
        // and the literal env overlaid.
        yield* expectUrlContains(`${site.url!}/`, `binding:${bindingMarker}`, {
          timeout: "120 seconds",
          label: "sveltekit dev SSR home with platform.env binding",
        });

        // API endpoint: node:crypto + platform.env through the dev server.
        yield* expectUrlContains(
          `${site.url!}/api/hello`,
          `"binding":"${bindingMarker}"`,
          {
            timeout: "60 seconds",
            label: "sveltekit dev API route",
          },
        );

        // Static asset from `static/`.
        yield* expectUrlContains(`${site.url!}/robots.txt`, "User-agent", {
          timeout: "60 seconds",
          label: "sveltekit dev static asset",
        });

        // ── local KV round-trip: the /api/kv routes write and read
        // `platform.env.SITE_KV`, backed by the local simulator ─────────────
        const kvValue = "sveltekit-dev-kv-value";
        yield* putTextReady(`${site.url!}/api/kv?key=greeting`, kvValue);
        const kvRead = yield* fetchJsonReady<{ value: string | null }>(
          `${site.url!}/api/kv?key=greeting`,
        );
        expect(kvRead.value).toBe(kvValue);

        // ── HMR: edit the home route in place; kit's dev server hot-reloads
        // and the dev URL serves the new markup without a redeploy ──────────
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const pagePath = path.join(rootDir, "src", "routes", "+page.svelte");
        const page = yield* fs.readFileString(pagePath);
        yield* fs.writeFileString(
          pagePath,
          page.replace("SvelteKit SSR home", "SvelteKit SSR home v2-marker"),
        );

        // Bounded poll: expectUrlContains retries with a capped backoff and
        // a hard total timeout.
        yield* expectUrlContains(`${site.url!}/`, "v2-marker", {
          timeout: "90 seconds",
          label: "sveltekit dev HMR-updated home page",
        });

        // The KV binding survives the hot reload.
        const kvReadAfterHmr = yield* fetchJsonReady<{ value: string | null }>(
          `${site.url!}/api/kv?key=greeting`,
        );
        expect(kvReadAfterHmr.value).toBe(kvValue);

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 300_000 },
  );

  /**
   * `Alchemy.remote()` opts the KV namespace OUT of local emulation: even
   * under `alchemy dev` it is created on real Cloudflare and the dev
   * server's `platform.env.SITE_KV` proxies to it remotely. Out-of-band
   * reads through the cloud API prove the dev server's write landed in the
   * real namespace, and destroy deletes it from the cloud (the state row is
   * stamped live).
   */
  test.provider(
    "SvelteKit dev: Alchemy.remote() KV namespace runs live behind the dev server",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-sveltekit-dev-remote-",
          tempRoot,
          entries: ["package.json", "src", "static"],
        });

        const { site, siteKv } = yield* stack.deploy(
          Effect.gen(function* () {
            const siteKv = yield* Cloudflare.KV.Namespace("RemoteSiteKV").pipe(
              Alchemy.remote(),
            );
            const site = yield* Cloudflare.Website.SvelteKit(
              "SvelteKitLocalRemoteKV",
              {
                rootDir,
                dev: { port: 0 },
                memo: { include: ["src/**", "static/**", "package.json"] },
                env: {
                  TEST_BINDING: "sveltekit-dev-remote-marker",
                  SITE_KV: siteKv,
                },
              },
            );
            return { site, siteKv };
          }),
        );

        // The remote() namespace is REAL — a cloud id, not a `dev:` one —
        // while the site itself still serves from the local dev proxy.
        expect(site.url).toMatch(/^http:\/\/localhost:\d+/);
        expect(isLocalId(siteKv.namespaceId)).toBe(false);
        expect(siteKv.namespaceId).not.toMatch(/^dev:/);

        // Write through the dev server's remote-proxied binding.
        const kvValue = "sveltekit-dev-remote-kv-value";
        yield* putTextReady(`${site.url!}/api/kv?key=remote-key`, kvValue);
        const kvRead = yield* fetchJsonReady<{ value: string | null }>(
          `${site.url!}/api/kv?key=remote-key`,
        );
        expect(kvRead.value).toBe(kvValue);

        // Out-of-band: the write is visible through the cloud API — the
        // binding really hit the live namespace.
        const { accountId } = yield* yield* CloudflareEnvironment;
        const cloudValue = yield* kv
          .getNamespaceValue({
            accountId,
            namespaceId: siteKv.namespaceId,
            keyName: "remote-key",
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
              times: 5,
            }),
          );
        expect(cloudValue).toBe(kvValue);

        yield* stack.destroy();

        // The live namespace was deleted from the cloud on destroy (its
        // state row is stamped live, so the live provider handles the
        // delete even in a dev run).
        const gone = yield* kv
          .getNamespace({
            accountId,
            namespaceId: siteKv.namespaceId,
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("NamespaceNotFound", () => Effect.succeed(true)),
          );
        expect(gone).toBe(true);
      }).pipe(logLevel),
    { timeout: 300_000 },
  );

  // ─────────────────────────────────────────────────────────────────────
  // SPA fixture under `alchemy dev`: pages are `ssr = false`, so a deep
  // link to a client route must serve the app shell (kit's Vite dev
  // server renders app.html with no page markup), while `+server.ts`
  // endpoints still execute server-side in the dev server with access to
  // `platform.env`.
  // ─────────────────────────────────────────────────────────────────────

  const spaFixtureDir = pathe.resolve(
    import.meta.dirname,
    "fixtures",
    "sveltekit-spa-app",
  );

  /** app.html marker in the SPA fixture — identifies the app shell. */
  const SPA_SHELL_MARKER = "sveltekit-spa-shell";

  test.provider(
    "SvelteKit dev: SPA deep links serve the app shell; server endpoints still run with platform.env bindings",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(spaFixtureDir, {
          prefix: "alchemy-sveltekit-dev-spa-",
          tempRoot,
          entries: ["package.json", "src"],
        });

        const bindingMarker = "sveltekit-dev-spa-binding-marker";

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.SvelteKit("SvelteKitSpaLocal", {
              rootDir,
              dev: { port: 0 },
              memo: { include: ["src/**", "package.json"] },
              // Same props as the live SPA test — in dev the build-time
              // fallback generation never runs (no build); kit's dev
              // server serves the shell for `ssr = false` routes itself.
              assets: { notFoundHandling: "single-page-application" },
              env: {
                TEST_BINDING: bindingMarker,
              },
            });
          }),
        );

        // Local identity: the url points at the alchemy dev proxy — no
        // cloud Worker exists.
        expect(site.url).toBeDefined();
        expect(site.url).toMatch(/^http:\/\/localhost:\d+/);

        // (a) A deep link to a CLIENT route serves the app shell — the
        // shell marker is present and the widget markup (which only ever
        // renders in the browser) is absent.
        const widgetsBody = yield* expectUrlContains(
          `${site.url!}/widgets`,
          SPA_SHELL_MARKER,
          {
            timeout: "120 seconds",
            label: "sveltekit dev SPA deep link serves the shell",
          },
        );
        expect(widgetsBody).not.toContain("sveltekit-spa-widgets");
        expect(widgetsBody).not.toContain("sprocket");

        // (b) The server endpoint executes in the dev server with the
        // binding overlaid on `platform.env`.
        const widgets = yield* fetchJsonReady<{
          server: boolean;
          message: string | null;
          widgets: Array<{ id: string; name: string }>;
        }>(`${site.url!}/api/widgets`);
        expect(widgets.server).toBe(true);
        expect(widgets.message).toBe(bindingMarker);
        expect(widgets.widgets.map((w) => w.name)).toEqual([
          "sprocket",
          "flange",
          "grommet",
        ]);

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 300_000 },
  );
});
