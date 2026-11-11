import * as NodeFs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import mime from "mime";
import type * as vite from "vite";
import * as Assets from "../../core/bindings/assets/Assets.ts";
import * as Loopback from "../../core/globals/Loopback.ts";
import { DEFAULT_COMPATIBILITY_DATE } from "../../core/internal/constants.ts";
// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
import { loadInternalWorker } from "../../core/internal/internal-worker.ts";
import { PluginContext } from "../../core/PluginContext.ts";
const AssetsWorker = {
  worker: () => loadInternalWorker("#cloudflare-runtime-vite-worker/assets/assets.worker"),
};
const RouterWorker = {
  worker: () => loadInternalWorker("#cloudflare-runtime-vite-worker/assets/router.worker"),
};
const ViteProxyWorker = {
  worker: () => loadInternalWorker("#cloudflare-runtime-vite-worker/assets/vite-proxy.worker"),
};
/** Must match `VITE_MISS_HEADER` in `vite-proxy.worker.ts`. */
const VITE_MISS_HEADER = "x-alchemy-vite-asset-miss";
/**
 * Marks a request the dev `ASSETS` binding sent through Vite's middleware, so
 * the proxy middleware passes it on instead of sending it back to the Worker.
 */
export const VITE_ASSET_REQUEST = Symbol.for("alchemy.cloudflare-runtime.vite-asset-request");
/**
 * Marker prefix used by the vite-aware asset worker to indicate that a
 * path lives inside Vite's `publicDir` (and so should be served verbatim,
 * without running through `transformIndexHtml`). It carries a leading slash
 * because the asset worker reads the key back as a URL pathname.
 */
const PUBLIC_DIR_PREFIX = "/__vite_public_dir__";

/**
 * Asset plugin layer wired to a Vite dev server.
 *
 * Unlike {@link Assets.AssetsLive}, this implementation does not build a
 * disk-backed asset manifest or KV namespace at all: the vite-aware asset
 * worker overrides `unstable_exists` / `unstable_getByETag` to delegate
 * every HTML lookup back to Vite via Loopback bindings, so HMR,
 * `transformIndexHtml`, virtual routes, and files in `publicDir` all
 * resolve through the dev server instead of through a static snapshot.
 *
 * Mirrors the dev-mode asset wiring in
 * `upstream/workers-sdk/packages/vite-plugin-cloudflare/src/miniflare-options.ts`.
 */
export const ViteAssetsLive = (
  viteDevServer: vite.ViteDevServer,
  options: {
    /** `false` for an assets-only site: requests no asset serves get a 404 instead of the Worker. */
    readonly hasUserWorker: boolean;
  },
) =>
  Layer.effect(
    Assets.Assets,
    Effect.gen(function* () {
      const loopback = yield* Loopback.Loopback;

      if (Effect.isEffect(loopback)) {
        return yield* Effect.die("Expected loopback to be initialized");
      }

      return Assets.Assets.of(
        Effect.gen(function* () {
          const { worker } = yield* PluginContext;
          const { assetsConfig, routerConfig } = yield* Assets.buildAssetConfigs(worker);

          const prefix = `vite-assets:${encodeURIComponent(worker.name)}`;
          const htmlExistsService = yield* loopback.api.route(
            `${prefix}:html-exists`,
            viteHtmlExistsHandler(viteDevServer),
          );
          const fetchHtmlService = yield* loopback.api.route(
            `${prefix}:fetch-html`,
            viteFetchHtmlHandler(viteDevServer),
          );
          const viteMiddlewareService = yield* loopback.api.route(
            `${prefix}:vite-middleware`,
            viteMiddlewareHandler(viteDevServer),
          );
          const [assetsWorker, routerWorker, viteProxyWorker] = yield* Effect.forEach(
            [AssetsWorker, RouterWorker, ViteProxyWorker],
            (worker) =>
              Effect.map(Effect.promise(worker.worker), ({ modules }) => modulesToWorkerd(modules)),
            { concurrency: "unbounded" },
          );

          return {
            services: [
              {
                // What a Worker's `ASSETS` binding calls (see
                // `vite-proxy.worker.ts`).
                name: "assets:worker",
                worker: {
                  compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
                  bindings: [
                    { name: "__VITE_MIDDLEWARE__", service: viteMiddlewareService },
                    { name: "ASSET_WORKER", service: { name: "assets:vite" } },
                  ],
                  modules: viteProxyWorker,
                },
              },
              {
                name: "assets:vite",
                worker: {
                  compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
                  // Node.js compatibility is supplied by the 2026-08-31
                  // internal compatibility date.
                  bindings: [
                    {
                      name: "CONFIG",
                      json: JSON.stringify(assetsConfig),
                    },
                    {
                      name: "__VITE_HEADERS__",
                      json: JSON.stringify(viteDevServer.config.server.headers ?? {}),
                    },
                    {
                      name: "__VITE_HTML_EXISTS__",
                      service: htmlExistsService,
                    },
                    {
                      name: "__VITE_FETCH_HTML__",
                      service: fetchHtmlService,
                    },
                  ],
                  modules: assetsWorker,
                },
              },
            ],
            middlewares: [
              {
                name: "assets:router",
                worker: {
                  compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
                  // The date supplies nodejs_compat; this worker deliberately
                  // retains only its v2 opt-out.
                  compatibilityFlags: ["no_nodejs_compat_v2"],
                  bindings: [
                    {
                      name: "ASSET_WORKER",
                      service: { name: "assets:vite" },
                    },
                    {
                      name: "CONFIG",
                      json: JSON.stringify({
                        ...routerConfig,
                        has_user_worker: options.hasUserWorker,
                      }),
                    },
                  ],
                  modules: routerWorker,
                },
                upstreamBindingName: "USER_WORKER",
                order: -1,
              },
            ],
            api: { isConfigured: true },
          };
        }),
      );
    }),
  );

/**
 * Returns the asset key for a pathname (or `null`): any file in Vite's
 * `publicDir`, or an HTML file under the root.
 * Files under Vite's `publicDir` are prefixed with `PUBLIC_DIR_PREFIX` so
 * the companion handler knows to skip `transformIndexHtml`.
 */
const viteHtmlExistsHandler =
  (viteDevServer: vite.ViteDevServer) => async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    const { root, publicDir } = viteDevServer.config;
    const publicDirInRoot = publicDir.startsWith(withTrailingSlash(root));
    const publicPath = withTrailingSlash(publicDir.slice(root.length));

    // Files served from the public dir are addressed from the root path.
    if (publicDirInRoot && pathname.startsWith(publicPath)) {
      return json(null);
    }

    // Vite resolves a disabled `publicDir` to `""`; joining that would read
    // the pathname as an absolute path on the host.
    const publicDirFilePath = publicDir ? `${publicDir}${pathname}` : undefined;
    const rootDirFilePath = `${root}${pathname}`;

    // Beyond the public dir only HTML resolves: other files under the root are Vite's modules.
    const candidates = [
      publicDirFilePath,
      pathname.endsWith(".html") ? rootDirFilePath : undefined,
    ].filter((candidate) => candidate !== undefined);
    for (const resolved of candidates) {
      try {
        const stats = await NodeFs.stat(resolved);
        if (stats.isFile()) {
          return json(
            resolved === publicDirFilePath ? `${PUBLIC_DIR_PREFIX}${pathname}` : pathname,
          );
        }
      } catch {
        // continue
      }
    }
    return json(null);
  };

/**
 * Returns the body for a path previously resolved by
 * {@link viteHtmlExistsHandler}. Non-public HTML is run through
 * `viteDevServer.transformIndexHtml` so that HMR and plugin transforms
 * apply; other public files are served as raw bytes.
 */
const viteFetchHtmlHandler =
  (viteDevServer: vite.ViteDevServer) => async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const { root, publicDir } = viteDevServer.config;
    const isInPublicDir = pathname.startsWith(PUBLIC_DIR_PREFIX);
    const resolved = isInPublicDir
      ? `${publicDir}${pathname.slice(PUBLIC_DIR_PREFIX.length)}`
      : `${root}${pathname}`;

    try {
      if (isInPublicDir && !resolved.endsWith(".html")) {
        const body = await NodeFs.readFile(resolved);
        res.writeHead(200, {
          "content-type": mime.getType(resolved) ?? "application/octet-stream",
        });
        res.end(body);
        return;
      }
      // Vite's bundled dev mode (`experimental.bundledDev`) serves HTML from
      // its in-memory bundle, as `@cloudflare/vite-plugin` reads it.
      const bundledDev = isInPublicDir ? undefined : bundledDevOf(viteDevServer);
      if (bundledDev) {
        const source = await readBundledFile(bundledDev, pathname.slice(1));
        res.writeHead(200, { "content-type": "text/html" });
        res.end(typeof source === "string" ? source : Buffer.from(source));
        return;
      }
      let html = await NodeFs.readFile(resolved, "utf-8");
      if (!isInPublicDir) {
        html = await viteDevServer.transformIndexHtml(resolved, html);
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
    } catch {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`Unexpected error. Failed to load "${pathname}".`);
    }
  };

interface BundledDev {
  triggerBundleRegenerationIfStale(): Promise<unknown>;
  memoryFiles: { get(key: string): { source: string | Uint8Array } | undefined };
}

const bundledDevOf = (viteDevServer: vite.ViteDevServer): BundledDev | undefined =>
  (viteDevServer.environments.client as { bundledDev?: BundledDev } | undefined)?.bundledDev;

/** A bundled file, once a regeneration the request triggered has written it. */
const readBundledFile = async (bundledDev: BundledDev, key: string) => {
  await bundledDev.triggerBundleRegenerationIfStale();
  const deadline = Date.now() + 10_000;
  let file = bundledDev.memoryFiles.get(key);
  while (!file && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    file = bundledDev.memoryFiles.get(key);
  }
  if (!file) {
    throw new Error(`No bundled file for "/${key}" after waiting for bundle regeneration.`);
  }
  return file.source;
};

/**
 * Runs a dev `ASSETS` request through Vite's middleware, as
 * `@cloudflare/vite-plugin` binds `ASSETS` in dev. A request no middleware
 * serves answers with {@link VITE_MISS_HEADER} so the proxy worker falls back
 * to the asset worker.
 */
const viteMiddlewareHandler =
  (viteDevServer: vite.ViteDevServer) => (req: IncomingMessage, res: ServerResponse) => {
    (req as IncomingMessage & { [VITE_ASSET_REQUEST]?: true })[VITE_ASSET_REQUEST] = true;
    viteDevServer.middlewares(req, res, () => {
      res.writeHead(404, { [VITE_MISS_HEADER]: "1" });
      res.end();
    });
  };

const withTrailingSlash = (s: string) => (s.endsWith("/") ? s : `${s}/`);

const modulesToWorkerd = (modules: Record<string, string>) =>
  Object.entries(modules).map(([name, esModule]) => ({
    name,
    esModule,
  }));
