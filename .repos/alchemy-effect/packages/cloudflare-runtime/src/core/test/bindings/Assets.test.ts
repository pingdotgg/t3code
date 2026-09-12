import { describe, expect, it, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
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

describe("Assets / buildAssetConfigs", () => {
  it("returns expected router and assets config", () => {
    const { routerConfig, assetsConfig } = Assets.buildAssetConfigs({
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
    const { routerConfig } = Assets.buildAssetConfigs({
      compatibilityDate: "2026-03-10",
      compatibilityFlags: [],
      assets: { directory: "/tmp/x", runWorkerFirst: false },
    });
    expect(routerConfig.invoke_user_worker_ahead_of_assets).toBe(false);
  });

  it("serves assets first when runWorkerFirst is omitted (wrangler default)", () => {
    const { routerConfig } = Assets.buildAssetConfigs({
      compatibilityDate: "2026-03-10",
      compatibilityFlags: [],
      assets: { directory: "/tmp/x" },
    });
    expect(routerConfig.invoke_user_worker_ahead_of_assets).toBe(false);
  });

  it("enables invoke_user_worker_ahead_of_assets when runWorkerFirst is true", () => {
    const { routerConfig } = Assets.buildAssetConfigs({
      compatibilityDate: "2026-03-10",
      compatibilityFlags: [],
      assets: { directory: "/tmp/x", runWorkerFirst: true },
    });
    expect(routerConfig.invoke_user_worker_ahead_of_assets).toBe(true);
  });
});
