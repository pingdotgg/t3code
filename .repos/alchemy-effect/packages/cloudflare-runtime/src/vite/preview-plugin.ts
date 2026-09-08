import { parseViteEnvironments } from "../rolldown/options.ts";
import type { OptionsApi } from "../rolldown/plugins/index.ts";
import { resolvePluginApi } from "../rolldown/utils.ts";
import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import { URL as NodeURL } from "node:url";
import type * as vite from "vite";
import { resolveForwardedHost } from "./forwarded-host.ts";
import type { CloudflareVitePluginOptions } from "./plugin.ts";
import { handleWebSocket } from "./websockets.ts";

/**
 * Preview mode: serve the freshly built worker through workerd.
 *
 * `vite preview` (and any framework that drives it programmatically — e.g.
 * waku's SSG step, which boots a preview server mid-`buildApp` and renders
 * every static page through it) resolves the same plugins as the build. This
 * plugin's `configurePreviewServer` hook reads the built worker output from
 * the entry environment's `build.outDir`, boots workerd over it via
 * `cloudflare-runtime`, and registers a proxy middleware ahead of Vite's
 * internal middlewares so every request — static assets included, via the
 * runtime's assets plugin — is handled exactly as on the deployed worker.
 *
 * This mirrors what upstream `@cloudflare/vite-plugin` provides via its own
 * `configurePreviewServer` (miniflare over the built output), and is what
 * makes SSG-in-workerd work: a top-level `import { env } from
 * "cloudflare:workers"` in a prerendered page module loads fine, because the
 * page renders inside workerd rather than the Node process.
 */
export function preview(options: CloudflareVitePluginOptions): vite.Plugin {
  return {
    name: "distilled-cloudflare:preview",
    async configurePreviewServer(server) {
      const config = server.config;
      const optionsApi = resolvePluginApi<OptionsApi>(
        config.plugins,
        "distilled-cloudflare:options",
      );
      if (!optionsApi) {
        throw new Error(
          "Cannot resolve the distilled-cloudflare:options plugin",
        );
      }
      const input = optionsApi.input();
      const inputNames = Object.keys(input);
      if (inputNames.length === 0) {
        // SPA mode: no worker entry — leave the preview server to Vite's
        // static file serving.
        return;
      }
      if (inputNames.length > 1) {
        throw new Error(
          `Expected exactly one entry in the input, got ${inputNames.length} entries: ${JSON.stringify(input)}`,
        );
      }
      const [entryEnvironmentName] = parseViteEnvironments(options);
      const entryEnvironment = config.environments[entryEnvironmentName!];
      if (!entryEnvironment) {
        throw new Error(
          `Cannot resolve the "${entryEnvironmentName}" environment from the preview config`,
        );
      }
      const directory = NodePath.resolve(
        config.root,
        entryEnvironment.build.outDir,
      );
      const entryModule = findEntryModule(directory, inputNames[0]!);
      const clientEnvironment = config.environments["client"];
      const assetsDirectory = clientEnvironment
        ? NodePath.resolve(config.root, clientEnvironment.build.outDir)
        : undefined;

      const { startPreviewServer } = await import("./preview-server.ts");
      const handle = await startPreviewServer(options, {
        directory,
        entryModule,
        assetsDirectory:
          assetsDirectory !== undefined && NodeFs.existsSync(assetsDirectory)
            ? assetsDirectory
            : undefined,
      });
      const address = handle.address;
      const removeUpgradeListener = server.httpServer
        ? handleWebSocket(server.httpServer, address)
        : undefined;
      const close = server.close.bind(server);
      server.close = async () => {
        removeUpgradeListener?.();
        await handle.close();
        await close();
      };
      // Registered directly (not via the returned post hook), so the proxy
      // runs ahead of Vite's internal static-file middlewares and of any
      // middleware a framework appends afterwards (e.g. waku's Node SSG
      // fallback) — the worker handles every request, like in production.
      server.middlewares.use(
        function distilledCloudflarePreviewMiddleware(req, res) {
          const url = new NodeURL(req.url ?? "/", address.toString());
          const request = NodeHttp.request(url, {
            method: req.method,
            headers: {
              ...req.headers,
              host: resolveForwardedHost(req.headers, url.host),
            },
          });
          req.pipe(request);
          request.on("response", (response) => {
            res.writeHead(response.statusCode ?? 500, response.headers);
            response.pipe(res);
          });
        },
      );
    },
  };
}

/**
 * Locate the built entry chunk for the (single) worker input. Entry chunks
 * are emitted as `[name].js` (Vite's server-build default `entryFileNames`);
 * `.mjs` is accepted for configs that override the extension.
 */
const findEntryModule = (directory: string, inputName: string): string => {
  const candidates = [`${inputName}.js`, `${inputName}.mjs`];
  for (const candidate of candidates) {
    if (NodeFs.existsSync(NodePath.join(directory, candidate))) {
      return candidate;
    }
  }
  throw new Error(
    `Cannot find the built worker entry (${candidates.join(" or ")}) in "${directory}". ` +
      "Run the build before starting the preview server.",
  );
};
