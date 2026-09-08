/**
 * Regression test for serving a Vite site on a zone route with a path
 * prefix.
 *
 * Cloudflare matches static assets against the FULL request pathname
 * (https://developers.cloudflare.com/workers/static-assets/routing/advanced/serving-a-subdirectory/):
 * a Worker routed at `zone/prefix*` only serves an asset for
 * `/prefix/index.html` if the uploaded asset manifest contains that key.
 * Vite's `base` (from the app's own vite.config.ts) rewrites the URLs the
 * build emits, and Alchemy keys the uploaded manifest with the same
 * resolved base — both halves are required for the site to work behind
 * the route. The SPA fallback shell is aliased back to `/index.html`
 * (Cloudflare resolves it at the manifest root, hard-coded), pinned here
 * by the deep-link probe.
 */
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Test from "@/Test/Alchemy";
import * as dns from "@distilled.cloud/cloudflare/dns";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const spaFixtureDir = pathe.resolve(import.meta.dirname, "vite-spa-fixture");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const zoneName =
  process.env.CLOUDFLARE_TEST_WORKER_ROUTE_ZONE_NAME ?? "alchemy-test-2.us";

// Deterministic per-user path prefix on the zone apex (never Date.now()).
const routePrefix = `alchemy-vite-route-repro-${process.env.PULL_REQUEST ?? process.env.USER}`;
const basePath = `/${routePrefix}/app`;
const routePattern = `${zoneName}${basePath}*`;
const routePageUrl = `https://${zoneName}${basePath}/`;

const marker = "vite-route-prefix-repro";

const htmlPage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${marker}</title>
  </head>
  <body>
    <div id="app">${marker}</div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
`;

// Capped: an uncapped exponential over 8 recurs sums to ~2 minutes and turns
// a persistent 403 into an apparent hang.
const forbiddenRetrySchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("2 seconds"),
]);

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(
      new Error(`zone "${zoneName}" not found in account`),
    );
  }
  return zone.id;
});

// Workers only run on proxied hostnames — the apex placeholder is standing
// test-zone infrastructure (see WorkerRoutes.test.ts); ensure, never delete.
const ensureApexPlaceholder = (zoneId: string) =>
  Effect.gen(function* () {
    const existing = yield* dns.listRecords.items({ zoneId }).pipe(
      Stream.filter(
        (r) => r.name === zoneName && (r.type === "A" || r.type === "AAAA"),
      ),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)[0]),
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: forbiddenRetrySchedule,
        times: 8,
      }),
    );
    if (existing) return;
    yield* dns.createRecord({
      zoneId,
      name: zoneName,
      type: "AAAA",
      content: "100::",
      proxied: true,
      ttl: 1,
      comment: "standing placeholder so Workers routes serve on the zone apex",
    });
  });

const purgeRoutes = (zoneId: string, ...patterns: string[]) =>
  Effect.forEach(patterns, (pattern) =>
    workers.listRoutes.items({ zoneId }).pipe(
      Stream.filter((r) => r.pattern === pattern),
      Stream.runCollect,
      Effect.flatMap(
        Effect.forEach((r) =>
          workers
            .deleteRoute({ zoneId, routeId: r.id })
            .pipe(Effect.catch(() => Effect.void)),
        ),
      ),
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: forbiddenRetrySchedule,
        times: 8,
      }),
    ),
  );

class ProbeFailed extends Data.TaggedError("ProbeFailed")<{
  url: string;
  message: string;
}> {}

interface ProbeResult {
  url: string;
  status: number;
  contentType: string | undefined;
  body: string;
}

// One GET with cache busting; retried below until the edge stops serving
// 5xx / Cloudflare error pages / stale-deploy 404s (route + worker + asset
// propagation).
const probeOnce = (url: string) =>
  Effect.tryPromise({
    try: async (signal): Promise<ProbeResult> => {
      const u = new URL(url);
      u.searchParams.set("__alchemy_cb", String(Date.now()));
      const res = await fetch(u, {
        signal,
        cache: "no-store",
        headers: { "cache-control": "no-cache", accept: "*/*" },
      });
      const body = await res.text();
      return {
        url,
        status: res.status,
        contentType: res.headers.get("content-type") ?? undefined,
        body,
      };
    },
    catch: (e) =>
      new ProbeFailed({
        url,
        message: e instanceof Error ? e.message : String(e),
      }),
  });

const isPropagating = (r: ProbeResult) =>
  r.status !== 200 ||
  r.body.includes("There is nothing here yet") ||
  /Error\s+1\d{3}/i.test(r.body);

const probeStable = (url: string) =>
  probeOnce(url).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (r: ProbeResult) => !isPropagating(r),
      // ~90s: workers.dev/zone-route propagation slows down when many
      // concurrent deploys enable fresh subdomains at once.
      times: 30,
    }),
    Effect.retry({
      while: (e) => e._tag === "ProbeFailed",
      schedule: Schedule.exponential("1 second"),
      times: 5,
    }),
  );

const excerpt = (s: string) => s.replace(/\s+/g, " ").slice(0, 200);

/**
 * End-to-end "does the SPA actually work here" check: the page must serve
 * the marker HTML AND the module script it references must be fetchable
 * (as JavaScript) from the same host.
 */
const evaluateSite = Effect.fn(function* (pageUrl: string, label: string) {
  const page = yield* probeStable(pageUrl);
  yield* Effect.log(
    `[${label}] page ${page.status} ${page.contentType ?? "-"} :: ${excerpt(page.body)}`,
  );
  const src = page.body.match(/<script[^>]+src="([^"]+)"/)?.[1];
  let script: ProbeResult | undefined;
  if (page.status === 200 && src) {
    const scriptUrl = new URL(src, pageUrl).toString();
    script = yield* probeStable(scriptUrl);
    yield* Effect.log(
      `[${label}] script ${scriptUrl} -> ${script.status} ${script.contentType ?? "-"} :: ${excerpt(script.body)}`,
    );
  }
  return { page, src, script };
});

// Tests are independent (per-test scratch stacks, private fixture clones),
// so run them concurrently; suites are sequential by default.
describe.concurrent("ViteRoutePrefix", () => {
  test.provider(
    "Vite: base from vite.config.ts serves the site on a path-prefixed zone route",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const zoneId = yield* resolveZoneId;

        yield* stack.destroy();
        yield* purgeRoutes(zoneId, routePattern);
        yield* ensureApexPlaceholder(zoneId);

        const rootDir = yield* cloneFixture(spaFixtureDir, {
          prefix: "alchemy-vite-route-",
          tempRoot,
          entries: ["index.html", "package.json", "src"],
        });
        yield* fs.writeFileString(path.join(rootDir, "index.html"), htmlPage);
        // The base lives in the app's own Vite config — the deploy adopts
        // the resolved value; nothing is configured on the alchemy side.
        yield* fs.writeFileString(
          path.join(rootDir, "vite.config.ts"),
          `import { defineConfig } from "vite";\n\nexport default defineConfig({ base: "${basePath}/" });\n`,
        );
        const memoInclude = [
          "index.html",
          "src/**",
          "package.json",
          "vite.config.ts",
        ];

        let workerName: string | undefined;

        yield* Effect.gen(function* () {
          const site = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Cloudflare.Website.Vite("ViteRoutePrefix", {
                rootDir,
                workersDev: true,
                compatibility: {
                  date: "2024-09-23",
                  flags: ["nodejs_compat"],
                },
                memo: { include: memoInclude },
                assets: { notFoundHandling: "single-page-application" },
                routes: [{ pattern: routePattern, zoneName }],
              });
            }),
          );
          workerName = site.workerName;

          expect(site.url).toBeDefined();
          expect(site.routes).toHaveLength(1);
          expect(site.routes[0]?.pattern).toEqual(routePattern);

          // Control — the same manifest serves under the prefix on
          // workers.dev too (the manifest is nested, not the route).
          const control = yield* evaluateSite(
            `${site.url!}${basePath}/`,
            "workers.dev",
          );
          expect(control.page.status).toBe(200);
          expect(control.page.body).toContain(marker);
          // Vite `base` bakes the prefix into the emitted script URL.
          expect(control.src).toContain(`${basePath}/`);
          expect(control.script?.status).toBe(200);
          expect(control.script?.contentType).toContain("javascript");

          // The point of the feature: the site works end-to-end behind the
          // path-prefixed zone route — HTML serves AND the module script it
          // references resolves under the prefix (inside the route).
          const routed = yield* evaluateSite(routePageUrl, "zone route");
          expect(routed.page.status).toBe(200);
          expect(routed.page.body).toContain(marker);
          expect(routed.script?.status).toBe(200);
          expect(routed.script?.contentType).toContain("javascript");
          // `(hydrated)` is a string literal in the fixture's client module,
          // so it proves the response is the real script — a 404 here would
          // be answered by the SPA fallback with the shell, which contains
          // the marker but never that literal.
          expect(routed.script?.body).toContain("(hydrated)");
          expect(
            routed.script?.url.startsWith(`https://${zoneName}${basePath}/`),
          ).toBe(true);

          // Cloudflare's SPA fallback resolves `/index.html` at the manifest
          // root, hard-coded — the shell is aliased back there so client-side
          // routes under the base still boot the app.
          const deep = yield* probeStable(
            `https://${zoneName}${basePath}/deep/route`,
          );
          yield* Effect.log(
            `[spa deep link] ${deep.status} ${deep.contentType ?? "-"} :: ${excerpt(deep.body)}`,
          );
          expect(deep.status).toBe(200);
          expect(deep.body).toContain(marker);
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* stack.destroy().pipe(Effect.ignore);
              yield* purgeRoutes(zoneId, routePattern).pipe(Effect.ignore);
              if (workerName) {
                yield* waitForWorkerToBeDeleted(workerName, accountId).pipe(
                  Effect.ignore,
                );
              }
            }),
          ),
        );
      }).pipe(logLevel),
    { timeout: 360_000 },
  );
});
