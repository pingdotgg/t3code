import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import { isLocalId } from "@/Cloudflare/LocalRuntime";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import * as kv from "@distilled.cloud/cloudflare/kv";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectUrlContains } from "../Utils/Http.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const fixtureDir = pathe.resolve(import.meta.dirname, "fixtures", "astro-app");
const staticFixtureDir = pathe.resolve(
  import.meta.dirname,
  "fixtures",
  "astro-static-app",
);
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

class DevResponseMismatch extends Data.TaggedError("DevResponseMismatch")<{
  url: string;
  detail: string;
}> {
  override get message() {
    return `${this.url} :: ${this.detail}`;
  }
}

const devRetry = Effect.retry({
  schedule: Schedule.min([
    Schedule.exponential("500 millis", 1.5),
    Schedule.spaced("4 seconds"),
  ]),
  times: 10,
});

/**
 * Cookie-aware fetch for the dev session round-trip: returns the body plus
 * the `astro-session` cookie pair from `set-cookie` (if any).
 */
const fetchSession = (url: string, cookie?: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const res = await fetch(url, {
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
      new DevResponseMismatch({
        url,
        detail: e instanceof Error ? e.message : String(e),
      }),
  });

/**
 * Fetch `url` and assert the exact `status` with a body containing
 * `marker` — used for the dev 404 page, which `expectUrlContains` can't
 * assert (it requires `res.ok`).
 */
const expectStatusBody = (url: string, status: number, marker: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const res = await fetch(url, {
        signal,
        cache: "no-store",
        headers: { "cache-control": "no-cache", accept: "*/*" },
      });
      return { status: res.status, body: await res.text() };
    },
    catch: (e) =>
      new DevResponseMismatch({
        url,
        detail: e instanceof Error ? e.message : String(e),
      }),
  }).pipe(
    Effect.filterOrFail(
      (r) => r.status === status && r.body.includes(marker),
      (r) =>
        new DevResponseMismatch({
          url,
          detail: `expected ${status} with "${marker}", got ${r.status} ${r.body.slice(0, 240)}`,
        }),
    ),
    devRetry,
  );

// Tests are independent (per-test scratch stacks, private fixture clones),
// so run them concurrently; suites are sequential by default.
describe.concurrent("Astro dev", () => {
  test.provider(
    "Astro dev: local dev server renders SSR with bindings and local sessions",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-astro-dev-",
          tempRoot,
          entries: ["astro.config.mjs", "package.json", "public", "src"],
        });

        const marker = "astro-dev-marker";

        const { site, sessions } = yield* stack.deploy(
          Effect.gen(function* () {
            const site = yield* Cloudflare.Website.Astro("AstroLocal", {
              rootDir,
              dev: { port: 0 },
              memo: {
                include: [
                  "src/**",
                  "public/**",
                  "astro.config.mjs",
                  "package.json",
                ],
              },
              env: { TEST_MARKER: marker },
            });
            // Dedupes by logical id — a handle on the session namespace the
            // Astro resource auto-provisioned, for the dev-identity assertion.
            const sessions =
              yield* Cloudflare.KV.Namespace("AstroLocalSession");
            return { site, sessions };
          }),
        );

        // Local identity: the url points at the alchemy dev proxy — no
        // cloud Worker exists.
        expect(site.url).toBeDefined();
        expect(site.url).toMatch(/^http:\/\/localhost:\d+/);

        // The auto-provisioned session namespace is emulated locally — a
        // `dev:` id is proof no cloud call ran.
        expect(isLocalId(sessions.namespaceId)).toBe(true);

        // SSR page rendered by astro's dev server (ssr environment runs
        // in workerd behind the proxy) — reads the TEST_MARKER binding.
        yield* expectUrlContains(`${site.url!}/`, marker, {
          timeout: "120 seconds",
          label: "astro dev SSR home with env binding",
        });

        // Prerendered route renders on demand in dev.
        yield* expectUrlContains(`${site.url!}/about/`, "prerendered-page", {
          timeout: "60 seconds",
          label: "astro dev prerender route",
        });

        // Static asset from `public/` through the dev server.
        yield* expectUrlContains(
          `${site.url!}/static.txt`,
          "astro-static-asset",
          {
            timeout: "60 seconds",
            label: "astro dev static asset",
          },
        );

        // ── sessions round-trip against the LOCAL simulator ────────────────
        const first = yield* fetchSession(`${site.url!}/session`).pipe(
          Effect.filterOrFail(
            (r) => r.status === 200 && r.body.includes("session-count=1"),
            (r) =>
              new DevResponseMismatch({
                url: `${site.url!}/session`,
                detail: `${r.status} ${r.body.slice(0, 240)}`,
              }),
          ),
          devRetry,
        );
        expect(first.sessionCookie).toBeDefined();

        const second = yield* fetchSession(
          `${site.url!}/session`,
          first.sessionCookie,
        ).pipe(
          Effect.filterOrFail(
            (r) => r.body.includes("session-count=2"),
            (r) =>
              new DevResponseMismatch({
                url: `${site.url!}/session`,
                detail: `expected session-count=2, got ${r.body.slice(0, 240)}`,
              }),
          ),
          devRetry,
        );
        expect(second.body).toContain("session-count=2");

        // Out-of-band: NO real cloud namespace was created for the
        // auto-provisioned session KV. (Physical titles embed the logical id
        // verbatim: `{stack}-AstroLocalSession-{stage}-{suffix}`.)
        const { accountId } = yield* yield* CloudflareEnvironment;
        const cloudNamespace = yield* kv.listNamespaces
          .items({ accountId })
          .pipe(
            Stream.filter((ns) => ns.title.includes("AstroLocalSession")),
            Stream.runHead,
            Effect.map(Option.getOrUndefined),
          );
        expect(cloudNamespace).toBeUndefined();

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 300_000 },
  );

  // ─────────────────────────────────────────────────────────────────────
  // Declared-static app in dev: `output: "static"` produces no
  // server modules — the dev server must still answer every route from the
  // assets-only dispatch, including the custom 404 page.
  // ─────────────────────────────────────────────────────────────────────

  test.provider(
    "Astro dev: declared-static app serves pages and the 404 page assets-only",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(staticFixtureDir, {
          prefix: "alchemy-astro-static-dev-",
          tempRoot,
          entries: ["package.json", "public", "src"],
        });

        const site = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Website.Astro("AstroStaticLocal", {
              rootDir,
              dev: { port: 0 },
              memo: {
                include: ["src/**", "public/**", "package.json"],
              },
              astro: { output: "static" },
              assets: { notFoundHandling: "404-page" },
            });
          }),
        );

        expect(site.url).toBeDefined();
        expect(site.url).toMatch(/^http:\/\/localhost:\d+/);

        yield* expectUrlContains(`${site.url!}/`, "static-home", {
          timeout: "120 seconds",
          label: "astro dev static home",
        });
        yield* expectUrlContains(`${site.url!}/about/`, "static-about", {
          timeout: "60 seconds",
          label: "astro dev static about",
        });
        // Unknown routes serve the custom 404 page with a real 404 status.
        yield* expectStatusBody(
          `${site.url!}/definitely-not-a-page`,
          404,
          "static-404",
        );

        yield* stack.destroy();
      }).pipe(logLevel),
    { timeout: 300_000 },
  );

  // ─────────────────────────────────────────────────────────────────────
  // `Alchemy.remote()` opt-out: the SITE_KV namespace runs LIVE even in a
  // dev run — the local dev server's binding proxies to the real cloud
  // namespace, and destroy deletes it from the cloud (stamped-mode delete).
  // ─────────────────────────────────────────────────────────────────────

  test.provider(
    "Astro dev: Alchemy.remote() SITE_KV binds the real namespace from the local server",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const rootDir = yield* cloneFixture(fixtureDir, {
          prefix: "alchemy-astro-remote-",
          tempRoot,
          entries: ["astro.config.mjs", "package.json", "public", "src"],
        });

        const marker = "astro-remote-marker";

        const { site, liveKv } = yield* stack.deploy(
          Effect.gen(function* () {
            const liveKv = yield* Cloudflare.KV.Namespace(
              "AstroRemoteSiteKV",
            ).pipe(Alchemy.remote());
            const site = yield* Cloudflare.Website.Astro("AstroRemoteLocal", {
              rootDir,
              dev: { port: 0 },
              memo: {
                include: [
                  "src/**",
                  "public/**",
                  "astro.config.mjs",
                  "package.json",
                ],
              },
              env: { TEST_MARKER: marker, SITE_KV: liveKv },
            });
            return { site, liveKv };
          }),
        );

        // The site itself is local; the remote() namespace is REAL.
        expect(site.url).toMatch(/^http:\/\/localhost:\d+/);
        expect(isLocalId(liveKv.namespaceId)).toBe(false);

        // Wait for the dev server before driving the binding.
        yield* expectUrlContains(`${site.url!}/`, marker, {
          timeout: "120 seconds",
          label: "astro dev home (remote kv stack)",
        });

        // Write through the remote-proxied binding via the fixture's
        // /api/kv route, then read it back through the same binding.
        yield* Effect.tryPromise({
          try: async (signal) => {
            const res = await fetch(
              `${site.url!}/api/kv?key=remote-key&value=${marker}`,
              { signal, method: "PUT", cache: "no-store" },
            );
            return { status: res.status, body: await res.text() };
          },
          catch: (e) =>
            new DevResponseMismatch({
              url: `${site.url!}/api/kv`,
              detail: e instanceof Error ? e.message : String(e),
            }),
        }).pipe(
          Effect.filterOrFail(
            (r) => r.status === 200,
            (r) =>
              new DevResponseMismatch({
                url: `${site.url!}/api/kv`,
                detail: `PUT ${r.status} ${r.body.slice(0, 240)}`,
              }),
          ),
          devRetry,
        );

        yield* expectStatusBody(
          `${site.url!}/api/kv?key=remote-key`,
          200,
          `"value":"${marker}"`,
        );

        // Out-of-band: the write landed in the REAL cloud namespace.
        const { accountId } = yield* yield* CloudflareEnvironment;
        const observed = yield* kv
          .getNamespaceValue({
            accountId,
            namespaceId: liveKv.namespaceId,
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
              times: 8,
            }),
          );
        expect(observed).toBe(marker);

        yield* stack.destroy();

        // The live namespace was deleted from the cloud on destroy (its
        // state row is stamped live, so the live provider handles the
        // delete even in a dev run).
        const gone = yield* kv
          .getNamespace({ accountId, namespaceId: liveKv.namespaceId })
          .pipe(
            Effect.as(false),
            Effect.catchTag("NamespaceNotFound", () => Effect.succeed(true)),
          );
        expect(gone).toBe(true);
      }).pipe(logLevel),
    { timeout: 300_000 },
  );
});
