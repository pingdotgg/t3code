import { describe, expect, it, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Assets from "../../bindings/assets/Assets.ts";
import { getFixture } from "../helpers/fixture.ts";
import { localRuntimeLayer, startTestWorker } from "../helpers/runtime.ts";

const ASSETS_SCRIPT = `
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/hello") return new Response("hello from API");
    return env.ASSETS.fetch(request);
  }
};
`;
const ASSETS_DIRECTORY = getFixture("assets");

layer(localRuntimeLayer)("Assets binding", (it) => {
  it.effect(
    "registers an assets:worker service when worker.assets is configured",
    () =>
      Effect.gen(function* () {
        const worker = yield* startTestWorker({
          name: "assets-bound",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          modules: [
            { name: "main.js", type: "ESModule", content: ASSETS_SCRIPT },
          ],
          assets: {
            directory: ASSETS_DIRECTORY,
            runWorkerFirst: ["/api/hello"],
          },
          bindings: [Assets.local("ASSETS")],
        });
        const text = yield* worker.fetchText("/");
        expect(text).toBe("<h1>home</h1>\n");
        const api = yield* worker.fetchText("/api/hello");
        expect(api).toBe("hello from API");
      }),
  );

  it.effect("applies _headers and _redirects rules when serving assets", () =>
    Effect.gen(function* () {
      const worker = yield* startTestWorker({
        name: "assets-headers-redirects",
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        modules: [
          { name: "main.js", type: "ESModule", content: ASSETS_SCRIPT },
        ],
        assets: {
          directory: ASSETS_DIRECTORY,
          headers: `/*
  X-Alchemy-Test: assets-config-header
`,
          redirects: "/old-path /index.html 301\n",
        },
        bindings: [Assets.local("ASSETS")],
      });
      const home = yield* worker.fetch("/");
      expect(home.status).toBe(200);
      expect(home.headers.get("x-alchemy-test")).toBe("assets-config-header");
      expect(yield* Effect.promise(() => home.text())).toBe("<h1>home</h1>\n");

      const redirected = yield* worker.fetch("/old-path", {
        redirect: "manual",
      });
      expect(redirected.status).toBe(301);
      const location = redirected.headers.get("location");
      expect(location).toBeTruthy();
      expect(new URL(location!, worker.baseUrl).pathname).toBe("/index.html");
    }),
  );

  it.effect(
    "Assets.binding fails with ConfigError when no assets are configured",
    () =>
      Effect.gen(function* () {
        const error = yield* startTestWorker({
          name: "assets-missing",
          compatibilityDate: "2026-03-10",
          compatibilityFlags: [],
          modules: [
            { name: "main.js", type: "ESModule", content: ASSETS_SCRIPT },
          ],
          bindings: [Assets.local("ASSETS")],
        }).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "ConfigError", subtag: "Assets" });
      }),
  );
});

const assetConfigs = (worker: Parameters<typeof Assets.buildAssetConfigs>[0]) =>
  Effect.runSync(Assets.buildAssetConfigs(worker));

describe("Assets / buildAssetConfigs", () => {
  it("returns expected router and assets config", () => {
    const { routerConfig, assetsConfig } = assetConfigs({
      compatibilityDate: "2026-03-10",
      compatibilityFlags: [],
      assets: {
        directory: "/tmp/x",
        notFoundHandling: "404-page",
        htmlHandling: "auto-trailing-slash",
        runWorkerFirst: ["/api/*"],
      },
    });
    expect(routerConfig).toMatchObject({
      // an array routes selectively via static_routing; the blanket
      // worker-first flag stays off so unmatched paths serve assets first
      invoke_user_worker_ahead_of_assets: false,
      has_user_worker: true,
    });
    expect(routerConfig.static_routing).toBeDefined();
    expect(assetsConfig).toMatchObject({
      compatibility_date: "2026-03-10",
      not_found_handling: "404-page",
      html_handling: "auto-trailing-slash",
      has_static_routing: true,
    });
  });

  it("disables invoke_user_worker_ahead_of_assets when runWorkerFirst is false", () => {
    const { routerConfig } = assetConfigs({
      compatibilityDate: "2026-03-10",
      compatibilityFlags: [],
      assets: { directory: "/tmp/x", runWorkerFirst: false },
    });
    expect(routerConfig.invoke_user_worker_ahead_of_assets).toBe(false);
  });

  it("serves assets first when runWorkerFirst is omitted (wrangler default)", () => {
    const { routerConfig } = assetConfigs({
      compatibilityDate: "2026-03-10",
      compatibilityFlags: [],
      assets: { directory: "/tmp/x" },
    });
    expect(routerConfig.invoke_user_worker_ahead_of_assets).toBe(false);
  });

  it("enables invoke_user_worker_ahead_of_assets when runWorkerFirst is true", () => {
    const { routerConfig } = assetConfigs({
      compatibilityDate: "2026-03-10",
      compatibilityFlags: [],
      assets: { directory: "/tmp/x", runWorkerFirst: true },
    });
    expect(routerConfig.invoke_user_worker_ahead_of_assets).toBe(true);
  });

  // Regression for https://github.com/alchemy-run/alchemy/pull/1418:
  // a `_headers` / `_redirects` file used to crash local asset serving
  // because constructHeaders/constructRedirects called logger.log with no
  // logger. They now log through Effect.log.
  it("constructs header and redirect configs from _headers/_redirects contents", () => {
    const { assetsConfig } = assetConfigs({
      compatibilityDate: "2026-03-10",
      compatibilityFlags: [],
      assets: {
        directory: "/tmp/x",
        headers: `/*
  X-Alchemy-Test: assets-config-header
`,
        redirects: "/old-path /index.html 301\n",
      },
    });
    expect(assetsConfig.headers).toEqual({
      version: 2,
      rules: {
        "/*": {
          set: { "x-alchemy-test": "assets-config-header" },
        },
      },
    });
    expect(assetsConfig.redirects).toEqual({
      version: 1,
      staticRules: {
        "/old-path": {
          status: 301,
          to: "/index.html",
          lineNumber: 1,
        },
      },
      rules: {},
    });
  });

  it("emits _headers/_redirects parse messages through Effect.log", () => {
    const messages: Array<string> = [];
    Effect.runSync(
      Assets.buildAssetConfigs({
        compatibilityDate: "2026-03-10",
        compatibilityFlags: [],
        assets: {
          directory: "/tmp/x",
          headers: `/*
  X-Alchemy-Test: assets-config-header
`,
          redirects: "/old-path /index.html 301\n",
        },
      }).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make((options) => {
              const parts = Array.isArray(options.message)
                ? options.message
                : [options.message];
              messages.push(parts.map(String).join(" "));
            }),
          ]),
        ),
      ),
    );
    expect(messages.some((m) => m.includes("valid header rule"))).toBe(true);
    expect(messages.some((m) => m.includes("valid redirect rule"))).toBe(true);
  });
});
