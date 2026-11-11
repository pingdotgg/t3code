import * as NodeNet from "node:net";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";
import { expectResponse, type ExpectedResponse } from "../Utils/Http.ts";
import { expectWorkerExists, waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

// Asset routing for `Website.Vite`, mirroring `@cloudflare/vite-plugin`'s
// `static-mpa`, `react-spa` and `spa-with-api` playgrounds. Each spec runs
// deployed and under `alchemy dev`, as the plugin runs each in build and dev
// mode; checks the plugin limits to one mode are limited the same way.

const { test } = Test.make({ providers: Cloudflare.providers() });
const { test: devTest } = Test.make({ providers: Cloudflare.providers(), dev: true });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");
const tempRoot = pathe.resolve(import.meta.dirname, "../../../.tmp");

type Mode = "live" | "dev";
type Check = (url: string, mode: Mode) => Effect.Effect<void, unknown>;

interface Variant {
  readonly fixture: string;
  readonly entries: ReadonlyArray<string>;
  readonly config?: string;
  readonly main?: string;
  readonly assets: Cloudflare.Website.ViteProps["assets"];
}

const deploySite = (stack: Test.ScratchStack, id: string, variant: Variant, mode: Mode) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const rootDir = yield* cloneFixture(pathe.resolve(import.meta.dirname, variant.fixture), {
      prefix: `alchemy-${variant.fixture}-`,
      tempRoot,
      entries: [...variant.entries],
    });
    if (variant.config) {
      yield* fs.copyFile(
        pathe.join(rootDir, "configs", `${variant.config}.ts`),
        pathe.join(rootDir, "vite.config.ts"),
      );
    }
    yield* fs.remove(pathe.join(rootDir, "configs"), { recursive: true, force: true });
    return yield* stack.deploy(
      Cloudflare.Website.Vite(id, {
        rootDir,
        workersDev: true,
        compatibility: { date: "2025-06-04", flags: ["nodejs_compat"] },
        memo: { include: ["**/*"] },
        main: variant.main,
        assets: variant.assets,
        ...(mode === "dev" ? { dev: { port: 0 } } : {}),
      }),
    );
  });

const routingTests = (
  name: string,
  id: string,
  variant: Variant,
  check: Check,
  modes: ReadonlyArray<Mode> = ["live", "dev"],
) => {
  if (modes.includes("live")) {
    test.provider(
      name,
      (stack) =>
        Effect.gen(function* () {
          const { accountId } = yield* yield* CloudflareEnvironment;
          yield* stack.destroy();
          const site = yield* deploySite(stack, id, variant, "live");
          yield* expectWorkerExists(site.workerName, accountId);
          yield* check(site.url!.replace(/\/$/, ""), "live");
          yield* stack.destroy();
          yield* waitForWorkerToBeDeleted(site.workerName, accountId);
        }).pipe(logLevel),
      { tags: ["provider:cloudflare:worker", "live"], timeout: 360_000 },
    );
  }
  if (modes.includes("dev")) {
    devTest.provider(
      `${name} (dev)`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const site = yield* deploySite(stack, `${id}Dev`, variant, "dev");
          yield* check(site.url!.replace(/\/$/, ""), "dev");
        }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore)), logLevel),
      { tags: ["provider:cloudflare:worker", "local"], timeout: 120_000 },
    );
  }
};

// The response head as a browser reads it: repeated header lines joined with
// `, `. Read over a raw socket because Bun's HTTP clients keep only the last
// of repeated lines, which Node's dev server sends for an array value.
const rawHeaders = (url: string) =>
  Effect.promise(
    () =>
      new Promise<Record<string, string>>((resolve, reject) => {
        const { hostname, port, pathname } = new URL(url);
        const socket = NodeNet.connect(Number(port), hostname, () =>
          socket.write(
            `GET ${pathname} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nConnection: close\r\n\r\n`,
          ),
        );
        let head = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          head += chunk;
          const end = head.indexOf("\r\n\r\n");
          if (end === -1) return;
          socket.destroy();
          const headers: Record<string, string> = {};
          for (const line of head.slice(0, end).split("\r\n").slice(1)) {
            const colon = line.indexOf(":");
            const name = line.slice(0, colon).trim().toLowerCase();
            const value = line.slice(colon + 1).trim();
            headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
          }
          resolve(headers);
        });
        socket.on("error", reject);
      }),
  );

// A browser navigation; the plugin's specs use `page.goto` for these.
const navigate = { "sec-fetch-mode": "navigate", accept: "text/html" };

const expectBody = (url: string, marker: string, status = 200, headers?: Record<string, string>) =>
  expectResponse(
    url,
    (res) =>
      res.status !== status
        ? `status ${res.status}, expected ${status}`
        : res.body.includes(marker)
          ? undefined
          : `body without "${marker}"`,
    { headers, label: `${url} → ${status} "${marker}"` },
  );

const expectHeader = (
  url: string,
  header: string,
  value: string | null,
  headers?: Record<string, string>,
) =>
  expectResponse(
    url,
    (res) =>
      res.headers.get(header) === value ? undefined : `${header}: ${res.headers.get(header)}`,
    { headers, label: `${url} → ${header}: ${value}` },
  );

const expectRedirect = (url: string, status: number, location: string) =>
  expectResponse(
    url,
    (res: ExpectedResponse) => {
      // Drop the helper's cache-busting query, which a redirect carries over.
      const actual = res.headers.get("location")?.replace(/[?&]__alchemy_cb=\d+$/, "");
      return res.status === status && actual === location ? undefined : `location ${actual}`;
    },
    { label: `${url} → ${status} ${location}` },
  );

const expectJson = (url: string, headers?: Record<string, string>) =>
  expectBody(url, '{"name":"Cloudflare"}', 200, headers);

describe.concurrent(
  "Vite asset routing",
  { tags: ["provider:cloudflare", "provider:cloudflare:website"] },
  () => {
    // `playground/static-mpa/__tests__/base-tests.ts`.
    routingTests(
      "Vite static MPA: pages, nested 404 pages, public HTML and _headers/_redirects",
      "FixViteStaticMpa",
      {
        fixture: "vite-static-mpa-fixture",
        entries: [
          "package.json",
          "vite.config.ts",
          "index.html",
          "404.html",
          "contact.html",
          "public-html.html",
          "about",
          "public",
        ],
        assets: { htmlHandling: "auto-trailing-slash", notFoundHandling: "404-page" },
      },
      (url, mode) =>
        Effect.gen(function* () {
          yield* expectBody(`${url}/`, "<h1>Home</h1>", 200, navigate);
          yield* expectBody(`${url}/contact`, "<h1>Contact</h1>", 200, navigate);
          // The canonical URL for a directory index has a trailing slash.
          yield* expectRedirect(`${url}/about`, 307, "/about/");
          yield* expectBody(`${url}/about/`, "<h1>About</h1>", 200, navigate);
          yield* expectBody(`${url}/random-page`, "<h1>Root 404</h1>", 404, navigate);
          yield* expectBody(`${url}/about/random-page`, "<h1>About 404</h1>", 404, navigate);
          // `public/public-html.html` wins over the root `public-html.html`.
          yield* expectBody(`${url}/public-html`, "<h1>Public Directory HTML</h1>", 200, navigate);
          yield* expectBody(`${url}/public/public-html`, "<h1>Root 404</h1>", 404, navigate);
          if (mode === "live") {
            yield* expectHeader(`${url}/contact`, "x-header", "exact-header");
            yield* expectHeader(`${url}/vite.svg`, "x-header", "splat-header");
            yield* expectRedirect(`${url}/home`, 302, "/");
            yield* expectRedirect(`${url}/contact/random-page`, 302, "/contact");
            // A redirect wins over an asset at its `from` path.
            yield* expectRedirect(`${url}/text-file.txt`, 302, "/");
          }
        }),
    );

    // `playground/react-spa/__tests__/react-spa.spec.ts`: `_headers` and
    // `_redirects` apply once built; in dev (without the plugin's experimental
    // support, which alchemy doesn't have) they don't.
    routingTests(
      "Vite SPA: not-found routes serve the app; _headers and _redirects apply once deployed",
      "FixViteSpaHeaders",
      {
        fixture: "vite-spa-headers-fixture",
        entries: ["package.json", "vite.config.ts", "configs", "index.html", "src", "public"],
        assets: { notFoundHandling: "single-page-application" },
      },
      (url, mode) =>
        Effect.gen(function* () {
          yield* expectBody(`${url}/`, "<h1>Vite SPA</h1>", 200, navigate);
          yield* expectBody(`${url}/random-page`, "<h1>Vite SPA</h1>", 200, navigate);
          if (mode === "live") {
            yield* expectHeader(`${url}/`, "x-header", "Custom-Value!!!");
            yield* expectHeader(`${url}/vite.svg`, "x-header", "Custom-Value!!!");
            yield* expectRedirect(`${url}/foo`, 302, "/bar");
            yield* expectRedirect(`${url}/redirect.svg`, 302, "/target.svg");
            yield* expectBody(`${url}/rewrite.svg`, "target.svg");
          } else {
            yield* expectHeader(`${url}/`, "x-header", null);
            yield* expectHeader(`${url}/vite.svg`, "x-header", null);
          }
        }),
    );

    // `playground/react-spa/__tests__/server-headers` (dev only).
    routingTests(
      "Vite SPA: server.headers apply to HTML and asset responses",
      "FixViteServerHeaders",
      {
        fixture: "vite-spa-headers-fixture",
        entries: ["package.json", "vite.config.ts", "configs", "index.html", "src", "public"],
        config: "server-headers",
        assets: { notFoundHandling: "single-page-application" },
      },
      (url) =>
        Effect.forEach(["/", "/vite.svg"], (path) =>
          rawHeaders(`${url}${path}`).pipe(
            Effect.tap((headers) =>
              Effect.sync(() =>
                expect({
                  string: headers["custom-string"],
                  array: headers["custom-string-array"],
                  number: headers["custom-number"],
                }).toEqual({ string: "string-value", array: "one, two, three", number: "123" }),
              ),
            ),
          ),
        ),
      ["dev"],
    );

    const spaApi = (config?: string, runWorkerFirst?: boolean | Array<string>): Variant => ({
      fixture: "vite-spa-api-fixture",
      entries: ["package.json", "vite.config.ts", "index.html", "src", "api", "public"],
      config,
      main: "./api/index.ts",
      assets: { notFoundHandling: "single-page-application", runWorkerFirst },
    });

    // `playground/spa-with-api/__tests__/spa-with-api.spec.ts`.
    routingTests(
      "Vite SPA with API: navigations get the app, other requests reach the Worker",
      "FixViteSpaApi",
      spaApi(),
      (url, mode) =>
        Effect.gen(function* () {
          yield* expectBody(`${url}/`, "<title>Vite SPA + API</title>", 200, navigate);
          yield* expectHeader(`${url}/`, "is-worker-response", null, navigate);
          yield* expectBody(`${url}/api/`, "<title>Vite SPA + API</title>", 200, navigate);
          yield* expectJson(`${url}/api/`);
          yield* expectBody(`${url}/foo`, "<title>Vite SPA + API</title>");
          yield* expectHeader(`${url}/foo`, "is-worker-response", "true");
          if (mode === "dev") {
            yield* expectBody(`${url}/api/some-file.txt`, "Some file content.");
          }
        }),
    );

    // `playground/spa-with-api/__tests__/static-routing`.
    routingTests(
      "Vite SPA with API: runWorkerFirst rules route matching paths to the Worker",
      "FixViteSpaApiStaticRouting",
      spaApi(undefined, ["/api/*", "!/api/asset.txt"]),
      (url, mode) =>
        Effect.gen(function* () {
          yield* expectHeader(`${url}/`, "is-worker-response", null, navigate);
          yield* expectJson(`${url}/api/`, navigate);
          yield* expectJson(`${url}/api/`);
          yield* expectBody(`${url}/api/asset`, "Modified: Asset content.");
          yield* expectBody(`${url}/foo`, "<title>Vite SPA + API</title>");
          yield* expectHeader(`${url}/foo`, "is-worker-response", null);
          if (mode === "dev") {
            yield* expectBody(`${url}/api/asset.txt`, "Asset content.");
            yield* expectJson(`${url}/api/some-file.txt`);
          }
        }),
    );

    // `playground/spa-with-api/__tests__/run-worker-first`.
    routingTests(
      "Vite SPA with API: runWorkerFirst true sends every request to the Worker",
      "FixViteSpaApiRunWorkerFirst",
      spaApi(undefined, true),
      (url, mode) =>
        Effect.gen(function* () {
          yield* expectHeader(`${url}/`, "is-worker-response", "true", navigate);
          yield* expectJson(`${url}/api/`, navigate);
          yield* expectJson(`${url}/api/`);
          yield* expectBody(`${url}/api/asset`, "Modified: Asset content.");
          yield* expectHeader(`${url}/foo`, "is-worker-response", "true", navigate);
          yield* expectHeader(`${url}/foo`, "is-worker-response", "true");
          if (mode === "dev") {
            yield* expectJson(`${url}/api/some-file.txt`);
          }
        }),
    );
  },
);
