import * as AWS from "@/AWS";
import { flociServices } from "@/AWS/Local/FlociServices.ts";
import * as Test from "@/Test/Alchemy";
import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command.
//
// These cases need floci's emulated CloudFront edge, which arrives with the
// next `DEFAULT_FLOCI_IMAGE` pin bump. Until then, run them against a locally
// built emulator: `ALCHEMY_FLOCI_IMAGE=floci:cf-edge pnpm test …`.
const { test } = Test.make({ providers: AWS.providers(), dev: true });

const fixtureDir = pathe.resolve(
  import.meta.dirname,
  "fixtures",
  "staticsite-dev",
);
const viteFixtureDir = pathe.resolve(
  import.meta.dirname,
  "fixtures",
  "vite-app",
);
// Clone under the alchemy package so `vite` resolves from the workspace's
// hoisted node_modules (the fixture has no node_modules of its own).
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

const htmlPage = (marker: string) => `<!doctype html>
<html>
  <head><title>${marker}</title></head>
  <body><h1>${marker}</h1></body>
</html>
`;

/**
 * Fetch the Router the way a developer does: open its URL.
 *
 * No Host header, no emulator endpoint, no TLS exception — `router.url` under
 * `alchemy dev` is a plain `http://localhost:<port>` the emulated distribution
 * is served on, so a browser (and this test) can just GET it. Needing anything
 * else here would mean the dev URL is not really usable.
 */
const fetchRouter = Effect.fn("fetchRouter")(function* (
  routerUrl: string,
  path: string,
) {
  const client = yield* HttpClient.HttpClient;
  return yield* client
    .get(`${routerUrl}${path}`)
    .pipe(
      Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 6 }),
    );
});

/**
 * Build one Router-attached dev site: a cloned fixture whose long-lived dev
 * server serves `site/<prefix>/index.html`, so the site behaves like a real
 * static host mounted under the Router's path prefix.
 */
const makeSiteFixture = Effect.fn("makeSiteFixture")(function* (
  prefix: string,
  marker: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* cloneFixture(fixtureDir, {
    prefix: `alchemy-aws-router-dev-${prefix}-`,
    tempRoot,
    entries: ["serve.mjs", "site"],
  });
  yield* fs.makeDirectory(path.join(cwd, "site", prefix), { recursive: true });
  yield* fs.writeFileString(
    path.join(cwd, "site", prefix, "index.html"),
    htmlPage(marker),
  );
  return cwd;
});

/**
 * What the Router answered with, when it isn't what the test expected.
 *
 * A typed failure (rather than an `expect` throw) so the assertion can be
 * retried: the dev server behind the mount may still be warming up, and a
 * live edit becomes visible one file-watcher tick after the write.
 */
class RouterBodyMismatch extends Data.TaggedError("RouterBodyMismatch")<{
  url: string;
  status: number;
  problem: string;
  bodyExcerpt: string;
}> {}

/**
 * GET `path` through the Router and assert what came back — status, markers
 * that must be present, and markers that must NOT be (the negative half is
 * what pins longest-prefix routing: a body is only proof if it could have
 * come from the *wrong* origin and didn't).
 */
const expectRouterBody = Effect.fn("expectRouterBody")(function* (
  routerUrl: string,
  path: string,
  options: {
    readonly includes?: ReadonlyArray<string>;
    readonly excludes?: ReadonlyArray<string>;
    readonly status?: number;
  },
) {
  const client = yield* HttpClient.HttpClient;
  const url = `${routerUrl}${path}`;
  const status = options.status ?? 200;
  return yield* Effect.gen(function* () {
    const response = yield* client.get(url);
    const body = yield* response.text;
    const missing = (options.includes ?? []).filter((m) => !body.includes(m));
    const present = (options.excludes ?? []).filter((m) => body.includes(m));
    if (
      response.status !== status ||
      missing.length > 0 ||
      present.length > 0
    ) {
      return yield* Effect.fail(
        new RouterBodyMismatch({
          url,
          status: response.status,
          problem: [
            response.status !== status
              ? `expected status ${status}`
              : undefined,
            missing.length > 0 ? `missing ${missing.join(", ")}` : undefined,
            present.length > 0
              ? `unexpectedly present ${present.join(", ")}`
              : undefined,
          ]
            .filter(Boolean)
            .join("; "),
          bodyExcerpt: body.slice(0, 240),
        }),
      );
    }
    return body;
  }).pipe(
    Effect.retry({
      schedule: Schedule.exponential("400 millis", 1.4),
      times: 8,
    }),
    Effect.tapError((error) =>
      Effect.logError(`expectRouterBody(${path}) failed`, error),
    ),
  );
});

/**
 * Clone the plain-Vite fixture and stamp per-site markers into it, so a body
 * served through the Router identifies WHICH dev server produced it.
 *
 * Returns the paths of the two files the live-edit assertions rewrite.
 */
const makeViteFixture = Effect.fn("makeViteFixture")(function* (
  slug: string,
  marker: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* cloneFixture(viteFixtureDir, {
    prefix: `alchemy-aws-router-vite-${slug}-`,
    tempRoot,
    entries: [".gitignore", "package.json", "index.html", "src", "public"],
  });
  const indexPath = path.join(cwd, "index.html");
  const mainPath = path.join(cwd, "src", "main.ts");
  const index = yield* fs.readFileString(indexPath);
  yield* fs.writeFileString(
    indexPath,
    index.replaceAll("VITE_AWS_PAGE_MARKER", `${marker}_PAGE`),
  );
  const main = yield* fs.readFileString(mainPath);
  yield* fs.writeFileString(
    mainPath,
    main.replaceAll("VITE_AWS_MODULE_MARKER", `${marker}_MODULE`),
  );
  return { cwd, indexPath, mainPath };
});

describe("AWS.Website.Router local", () => {
  /**
   * The whole point of the local Router: two sites, one Router, real HTTP
   * through the emulated CloudFront distribution, each path prefix reaching
   * its own dev server. No CloudFront deploy — the distribution, its KV
   * store, its viewer-request function and the routing all run in floci.
   */
  test.provider(
    "two dev sites route through one emulated distribution",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const cwdA = yield* makeSiteFixture("site-a", "router-dev-site-a");
        const cwdB = yield* makeSiteFixture("site-b", "router-dev-site-b");

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const router = yield* AWS.Website.Router("DevRouter", {});
            const siteA = yield* AWS.Website.StaticSite("SiteA", {
              path: cwdA,
              dev: { command: "bun serve.mjs", env: { DEV_MARKER: "site-a" } },
              domain: { router, path: "/site-a" },
            });
            const siteB = yield* AWS.Website.StaticSite("SiteB", {
              path: cwdB,
              dev: { command: "bun serve.mjs", env: { DEV_MARKER: "site-b" } },
              domain: { router, path: "/site-b" },
            });
            return {
              routerUrl: router.url,
              distributionId: router.distributionId,
              kvNamespace: router.kvNamespace,
              siteA: { url: siteA.url, kvNamespace: siteA.kvNamespace },
              siteB: { url: siteB.url, kvNamespace: siteB.kvNamespace },
            };
          }),
        );

        const routerUrl = deployed.routerUrl as string;
        // The Router is a real (emulated) CloudFront distribution — the same
        // resource graph a deploy produces, not a dev-only substitute — served
        // on a local port of its own, because `E….cloudfront.net` resolves to
        // nothing on a developer's machine.
        expect(routerUrl).toMatch(/^http:\/\/localhost:\d+$/);
        // Each site kept its own dev server as its `url` (HMR is the point of
        // dev) while still registering with the Router.
        expect(deployed.siteA.url).toMatch(/^http:\/\/localhost:\d+/);
        expect(deployed.siteB.url).toMatch(/^http:\/\/localhost:\d+/);
        expect(deployed.siteA.url).not.toBe(deployed.siteB.url);
        expect(deployed.siteA.kvNamespace).toBeDefined();
        expect(deployed.siteB.kvNamespace).not.toBe(deployed.siteA.kvNamespace);

        // ── Routing: each prefix reaches its own dev server ────────────────
        const a = yield* fetchRouter(routerUrl, "/site-a/");
        expect(a.status).toBe(200);
        expect(yield* a.text).toContain("router-dev-site-a");

        const b = yield* fetchRouter(routerUrl, "/site-b/");
        expect(b.status).toBe(200);
        expect(yield* b.text).toContain("router-dev-site-b");

        // A mount is a path SEGMENT prefix, not a string prefix: `/site-a-x`
        // shares seven characters with `/site-a` and must not be routed to it.
        const neighbour = yield* fetchRouter(routerUrl, "/site-a-x");
        expect(yield* neighbour.text).not.toContain("router-dev-site-a");

        // ── The origin received the request CloudFront would have sent ─────
        const echo = yield* fetchRouter(routerUrl, "/site-a/__echo");
        expect(echo.status).toBe(200);
        const echoed = (yield* echo.json) as {
          marker: string;
          path: string;
          headers: Record<string, string>;
        };
        expect(echoed.marker).toBe("site-a");
        expect(echoed.path).toBe("/site-a/__echo");
        // `routeSite` sets x-forwarded-host to the viewer's Host before it
        // rewrites the origin — the site's dev server sees the hostname the
        // request arrived on, exactly as a deployed server origin would.
        expect(echoed.headers["x-forwarded-host"]).toBe(
          new URL(routerUrl).host,
        );

        // ── Live edit: the dev server reads from disk per request, so the
        // next edge request serves the new content without re-applying ─────
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.writeFileString(
          path.join(cwdA, "site", "site-a", "index.html"),
          htmlPage("router-dev-site-a-v2"),
        );
        const edited = yield* fetchRouter(routerUrl, "/site-a/");
        expect(yield* edited.text).toContain("router-dev-site-a-v2");

        yield* stack.destroy();
      }),
    { timeout: 300_000 },
  );

  /**
   * The framework path — the one a real `alchemy dev` user is on.
   *
   * A framework dev server is not a hand-written fixture: it binds where the
   * framework decides (Vite picks `[::1]`), serves modules the HTML it
   * generated points at, and rewrites those URLs by `base`. The emulated edge
   * runs in a container and reaches the host through its gateway, so a
   * loopback-only listener answers nothing and every request through the
   * Router 502s.
   *
   * So this case is deliberately end-to-end through `router.url` only: the
   * HTML shell, the module URLs that HTML actually references, and a live
   * edit landing on a later request. Nothing here inspects the bind address
   * (not portable) — the route working IS the proof.
   */
  test.provider(
    "a Vite dev server serves its whole mount through the Router",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        yield* stack.destroy();

        const root = yield* makeViteFixture("root", "ROUTER_VITE_ROOT");
        const app = yield* makeViteFixture("app", "ROUTER_VITE_APP");

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const router = yield* AWS.Website.Router("ViteRouter", {});
            const rootSite = yield* AWS.Website.Vite("RootSite", {
              rootDir: root.cwd,
              domain: { router },
            });
            const appSite = yield* AWS.Website.Vite("AppSite", {
              rootDir: app.cwd,
              domain: { router, path: "/app" },
              // The Router forwards the FULL uri to the origin — it never
              // strips the mount prefix — so the dev server has to serve at
              // the prefix. `vite.base` is what makes Vite do that, for both
              // the module URLs it writes into the HTML and the requests it
              // then has to answer. Passed as the deploy-time override bag
              // (merged over the fixture's config file, which has none).
              vite: { base: "/app/" },
            });
            return {
              routerUrl: router.url,
              rootUrl: rootSite.url,
              appUrl: appSite.url,
            };
          }),
        );

        const routerUrl = deployed.routerUrl as string;
        expect(routerUrl).toMatch(/^http:\/\/localhost:\d+$/);
        // Each site's own `url` is still its dev server (HMR is the point).
        expect(deployed.rootUrl).toMatch(/^http:\/\/localhost:\d+/);
        expect(deployed.appUrl).toMatch(/^http:\/\/localhost:\d+/);
        expect(deployed.appUrl).not.toBe(deployed.rootUrl);

        // ── The HTML shell at each mount, from its own dev server ──────────
        const rootHtml = yield* expectRouterBody(routerUrl, "/", {
          includes: ["ROUTER_VITE_ROOT_PAGE"],
          excludes: ["ROUTER_VITE_APP_PAGE"],
        });
        const appHtml = yield* expectRouterBody(routerUrl, "/app/", {
          includes: ["ROUTER_VITE_APP_PAGE"],
          excludes: ["ROUTER_VITE_ROOT_PAGE"],
        });

        // Vite rewrote the asset URLs by `base`, so the browser's next hops
        // are the prefixed ones. Assert that BEFORE fetching them — otherwise
        // the fetches below could pass against URLs no real browser requests.
        expect(appHtml).toContain('src="/app/src/main.ts"');
        expect(appHtml).toContain("/app/@vite/client");
        expect(rootHtml).toContain('src="/src/main.ts"');
        expect(rootHtml).toContain("/@vite/client");

        // ── The assets that HTML points at, through the Router ─────────────
        // A mount only works if its sub-resources resolve; an index page that
        // renders while its modules 404 is a broken site.
        yield* expectRouterBody(routerUrl, "/app/src/main.ts", {
          includes: ["ROUTER_VITE_APP_MODULE"],
          excludes: ["ROUTER_VITE_ROOT_MODULE"],
        });
        yield* expectRouterBody(routerUrl, "/app/@vite/client", {
          includes: ["export"],
        });
        yield* expectRouterBody(routerUrl, "/src/main.ts", {
          includes: ["ROUTER_VITE_ROOT_MODULE"],
          excludes: ["ROUTER_VITE_APP_MODULE"],
        });
        yield* expectRouterBody(routerUrl, "/@vite/client", {
          includes: ["export"],
        });

        // ── Longest-prefix routing: neither mount answers the other's ──────
        // The root site matches `/` and would happily serve `/app/...` if the
        // longer prefix didn't win; the app site must not leak out of `/app`.
        yield* expectRouterBody(routerUrl, "/app/src/main.ts", {
          excludes: ["ROUTER_VITE_ROOT_MODULE"],
        });
        // `/app-other` shares a string prefix with `/app` but is NOT under the
        // mount — it belongs to the root site (whose SPA fallback answers it).
        yield* expectRouterBody(routerUrl, "/app-other", {
          includes: ["ROUTER_VITE_ROOT_PAGE"],
          excludes: ["ROUTER_VITE_APP_PAGE"],
        });

        // ── Live edit: the origin is a RUNNING dev server, not a copy ──────
        // Nothing is re-applied; the next request through the edge has to
        // show the new bytes. `?v=2` also defeats any cache in between.
        const editedMain = (yield* fs.readFileString(app.mainPath)).replace(
          "ROUTER_VITE_APP_MODULE",
          "ROUTER_VITE_APP_MODULE_V2",
        );
        yield* fs.writeFileString(app.mainPath, editedMain);
        yield* expectRouterBody(routerUrl, "/app/src/main.ts?v=2", {
          includes: ["ROUTER_VITE_APP_MODULE_V2"],
        });

        const editedIndex = (yield* fs.readFileString(root.indexPath)).replace(
          "ROUTER_VITE_ROOT_PAGE",
          "ROUTER_VITE_ROOT_PAGE_V2",
        );
        yield* fs.writeFileString(root.indexPath, editedIndex);
        yield* expectRouterBody(routerUrl, "/?v=2", {
          includes: ["ROUTER_VITE_ROOT_PAGE_V2"],
        });

        yield* stack.destroy();
      }),
    // 300s like the sibling cases: fixture clone + `bun install` + vite dev
    // boot through the emulated edge stack up under whole-suite concurrency
    // (the test itself runs in ~6s in isolation).
    { timeout: 300_000 },
  );

  /**
   * The emulated runtime must be at least as restrictive as CloudFront's.
   * CloudFront Functions are not Node: there is no `fetch`. Code that reaches
   * for one has to fail locally, or `alchemy dev` becomes a way to ship
   * broken edge code.
   */
  test.provider(
    "edge code that reaches outside the CloudFront runtime fails locally",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const router = yield* AWS.Website.Router("SandboxRouter", {
              edge: {
                viewerRequest: {
                  injection: `await fetch("https://example.com/");`,
                },
              },
            });
            return { routerUrl: router.url };
          }),
        );

        const response = yield* fetchRouter(
          deployed.routerUrl as string,
          "/anything",
        );
        expect(response.status).toBe(502);
        const body = yield* response.text;
        expect(body).toContain("fetch is not defined");
        expect(body).toContain("not Node.js");

        yield* stack.destroy();
      }),
    { timeout: 180_000 },
  );

  /**
   * `TestFunction` and the edge are backed by the same runtime, so the request
   * object the API reports is the request the origin actually received. That
   * is what makes a local result comparable to the same call against real AWS
   * (which runs the function in AWS's own engine against the DEVELOPMENT
   * stage — seconds, no distribution deploy).
   */
  test.provider(
    "TestFunction agrees with the edge",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const cwd = yield* makeSiteFixture("docs", "router-parity-docs");

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            const router = yield* AWS.Website.Router("ParityRouter", {});
            yield* AWS.Website.StaticSite("Docs", {
              path: cwd,
              dev: { command: "bun serve.mjs", env: { DEV_MARKER: "docs" } },
              domain: { router, path: "/docs" },
            });
            return { routerUrl: router.url };
          }),
        );

        const routerUrl = deployed.routerUrl as string;
        const host = new URL(routerUrl).host;

        // What the edge produced, as observed by the origin itself.
        const echo = yield* fetchRouter(routerUrl, "/docs/__echo?q=1");
        const echoed = (yield* echo.json) as {
          path: string;
          headers: Record<string, string>;
        };

        // The same event, through the TestFunction API. The out-of-band SDK
        // calls are pinned to the emulator explicitly — the test process's
        // own distilled clients otherwise point at the real account.
        const result = yield* Effect.gen(function* () {
          const functions = yield* cloudfront.listFunctions({});
          const summary = functions.FunctionList?.Items?.find(
            (item) =>
              item.FunctionConfig.Comment === "ParityRouter viewer request",
          );
          expect(summary).toBeDefined();
          const described = yield* cloudfront.describeFunction({
            Name: summary!.Name,
            Stage: "DEVELOPMENT",
          });
          return yield* cloudfront.testFunction({
            Name: summary!.Name,
            IfMatch: described.ETag!,
            Stage: "DEVELOPMENT",
            EventObject: new TextEncoder().encode(
              JSON.stringify({
                version: "1.0",
                context: { eventType: "viewer-request" },
                viewer: { ip: "127.0.0.1" },
                request: {
                  method: "GET",
                  uri: "/docs/__echo",
                  querystring: { q: { value: "1" } },
                  headers: { host: { value: host } },
                  cookies: {},
                },
              }),
            ),
          });
        }).pipe(Effect.provide(flociServices()));

        expect(result.TestResult?.FunctionErrorMessage).toBeUndefined();
        // `FunctionOutput` is modelled as a sensitive string, so it arrives
        // wrapped — unwrap before parsing.
        const rawOutput = result.TestResult?.FunctionOutput;
        const output = JSON.parse(
          rawOutput === undefined
            ? "{}"
            : typeof rawOutput === "string"
              ? rawOutput
              : Redacted.value(rawOutput),
        ) as { request?: { uri: string; headers: Record<string, any> } };
        expect(output.request?.uri).toBe(echoed.path);
        expect(output.request?.headers["x-forwarded-host"]?.value).toBe(
          echoed.headers["x-forwarded-host"],
        );

        yield* stack.destroy();
      }),
    { timeout: 300_000 },
  );

  /**
   * The oracle for everything above: run the same function through AWS's own
   * engine and compare. `TestFunction` executes against the `DEVELOPMENT`
   * stage, so this costs seconds and never touches a distribution.
   *
   * Gated because it needs real credentials — `AWS_TEST_CLOUDFRONT_FUNCTION=1
   * pnpm test test/AWS/Website/Router.local.test.ts --profile testing`.
   */
  test.provider.skipIf(process.env.AWS_TEST_CLOUDFRONT_FUNCTION !== "1")(
    "the emulated runtime agrees with the real CloudFront runtime",
    () =>
      Effect.gen(function* () {
        const name = "alchemy-cf-runtime-parity";
        const event = new TextEncoder().encode(
          JSON.stringify({
            version: "1.0",
            context: { eventType: "viewer-request" },
            viewer: { ip: "127.0.0.1" },
            request: {
              method: "GET",
              uri: "/docs",
              querystring: { q: { value: "1" } },
              headers: { host: { value: "example.cloudfront.net" } },
              cookies: {},
            },
          }),
        );

        /** Create, test, and delete a function against whichever endpoint is in scope. */
        const runThere = Effect.fn("runThere")(function* (
          suffix: string,
          code: string,
        ) {
          const created = yield* cloudfront.createFunction({
            Name: `${name}-${suffix}`,
            FunctionConfig: { Comment: "parity", Runtime: "cloudfront-js-2.0" },
            FunctionCode: new TextEncoder().encode(code),
          });
          const result = yield* cloudfront.testFunction({
            Name: `${name}-${suffix}`,
            IfMatch: created.ETag!,
            Stage: "DEVELOPMENT",
            EventObject: event,
          });
          yield* cloudfront
            .deleteFunction({
              Name: `${name}-${suffix}`,
              IfMatch: created.ETag!,
            })
            .pipe(Effect.ignore);
          const raw = result.TestResult?.FunctionOutput;
          return {
            error: result.TestResult?.FunctionErrorMessage,
            output:
              raw === undefined
                ? undefined
                : typeof raw === "string"
                  ? raw
                  : Redacted.value(raw),
          };
        });

        // A well-behaved function: both engines must produce the same request.
        const wellBehaved = `async function handler(event) {
  event.request.headers["x-forwarded-host"] = event.request.headers.host;
  event.request.uri = event.request.uri + "/index.html";
  return event.request;
}`;
        const local = yield* runThere("ok", wellBehaved).pipe(
          Effect.provide(flociServices()),
        );
        const real = yield* runThere("ok", wellBehaved);
        expect(local.error).toBeUndefined();
        expect(real.error).toBeUndefined();
        expect(JSON.parse(local.output!)).toEqual(JSON.parse(real.output!));

        // Reaching outside the runtime: both engines must report an error.
        const escaping = `async function handler(event) {
  await fetch("https://example.com/");
  return event.request;
}`;
        const localError = yield* runThere("escape", escaping).pipe(
          Effect.provide(flociServices()),
        );
        const realError = yield* runThere("escape", escaping);
        expect(localError.error).toBeDefined();
        expect(realError.error).toBeDefined();
      }),
    { timeout: 180_000 },
  );
});
