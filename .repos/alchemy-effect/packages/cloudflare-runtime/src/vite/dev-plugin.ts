import type { ExportTypes } from "../rolldown/export-types.ts";
import {
  haveExportTypesChanged,
  isExportTypes,
  WORKER_EXPORT_TYPES_EVENT,
} from "../rolldown/export-types.ts";
import { parseViteEnvironments } from "../rolldown/options.ts";
import type { OptionsApi } from "../rolldown/plugins/index.ts";
import { workerEntryId } from "../rolldown/plugins/index.ts";
import { resolvePluginApi } from "../rolldown/utils.ts";
import type { RuntimeServices } from "../core/index.ts";
import type * as Context from "effect/Context";
import * as NodeHttp from "node:http";
import { URL as NodeURL } from "node:url";
import * as vite from "vite";
import { DistilledDevEnvironment } from "./dev-environment.ts";
import type { ServerHandle } from "./dev-server.ts";
import { configuredExportTypes, mergeExportTypes } from "./export-types.ts";
import { resolveForwardedHost } from "./forwarded-host.ts";
import type { CloudflareVitePluginOptions } from "./plugin.ts";
import { handleWebSocket } from "./websockets.ts";

let context: Context.Context<RuntimeServices> | undefined;

export function dev(options: CloudflareVitePluginOptions): Array<vite.Plugin> {
  const environmentNames = parseViteEnvironments(options);
  const configured = configuredExportTypes(options);
  // Which exports the running Worker was generated for. Kept across dev server
  // restarts so a restart does not undo what was detected.
  let exportTypes: ExportTypes = configured;
  let handle: ServerHandle | undefined;
  let isServerRestarting = false;
  let removeUpgradeListener: (() => void) | undefined;
  const close = async () => {
    removeUpgradeListener?.();
    removeUpgradeListener = undefined;
    await handle?.close();
    handle = undefined;
  };
  let optionsApi: OptionsApi | undefined;
  const plugins: Array<vite.Plugin> = [];
  // The proxy middleware registers in a `configureServer` post callback, which
  // Vite runs in plugin order — so when this plugin is appended after a
  // framework's plugins, the framework's own post middlewares (e.g. a Node
  // request bridge that assumes a runnable environment) would see requests
  // first. With `middlewareOrder: "pre"` the proxy is instead inserted
  // directly after Vite's internal middlewares, ahead of every other plugin's
  // post middlewares. This companion plugin records that insertion point: its
  // post callback runs before all normal plugins' post callbacks (it is
  // `enforce: "pre"`), i.e. right after Vite registered its internal
  // middlewares and before any other plugin registered post middlewares.
  let middlewareBoundary: number | undefined;
  if (options.dev?.middlewareOrder === "pre") {
    plugins.push({
      name: "distilled-cloudflare:dev-middleware-boundary",
      enforce: "pre",
      configureServer(server) {
        middlewareBoundary = undefined;
        return () => {
          middlewareBoundary = server.middlewares.stack.length;
        };
      },
    });
  }
  const plugin: vite.Plugin = {
    name: "distilled-cloudflare:dev",
    configResolved({ plugins }) {
      optionsApi = resolvePluginApi<OptionsApi>(
        plugins ?? [],
        "distilled-cloudflare:options",
      );
    },
    config() {
      const environment: vite.EnvironmentOptions = {
        dev: {
          createEnvironment(name, config) {
            // Framework integrations strip `configureServer` off this plugin
            // when they create throwaway dev servers (e.g. Astro's type-gen
            // during `build`/`sync`) so we don't boot workerd mid-build. In
            // that case there is no runtime to proxy to — degrade to Vite's
            // default runnable environment. Check this exact plugin instance
            // (not the resolved plugin list) so multiple instances and
            // renamed/wrapped plugins behave predictably.
            if (!hasConfigureServerHook(plugin)) {
              return vite.createRunnableDevEnvironment(name, config);
            }
            return new DistilledDevEnvironment(name, config);
          },
        },
      };
      return {
        environments: Object.fromEntries(
          environmentNames.map((name) => [name, environment]),
        ),
      };
    },
    async buildEnd() {
      if (!isServerRestarting) {
        await close();
      }
    },
    async closeBundle() {
      if (!isServerRestarting) {
        await close();
      }
    },
    async configureServer(server) {
      const restartServer = server.restart.bind(server);
      server.restart = async () => {
        try {
          isServerRestarting = true;
          await restartServer();
        } finally {
          isServerRestarting = false;
        }
      };
      if (!optionsApi) {
        throw new Error("Cannot resolve the cloudflare-runtime:options plugin");
      }
      const inputs = Object.values(optionsApi.input());
      if (inputs.length > 1) {
        throw new Error(
          `Expected exactly one entry in the input, got ${inputs.length} entries: ${JSON.stringify(inputs)}`,
        );
      }
      const { createDefaultContext, startServer } =
        await import("./dev-server.ts");
      if (!options.context) {
        context ??= await createDefaultContext();
      }
      const [input] = inputs;
      const entryEnvironment = {
        environmentName: environmentNames[0],
        // The module runner imports the generated Worker entry rather than the
        // user entry: it is the module that re-exports everything the Worker
        // needs and that reports its export types over `import.meta.hot`.
        entryId: input ? workerEntryId(input) : input,
        entryName: input,
      };
      const entryEnvironments = () =>
        environmentNames
          .map((name) => server.environments[name])
          .filter(
            (environment) => environment instanceof DistilledDevEnvironment,
          );

      const connect = async (address: ServerHandle["address"]) => {
        for (const environment of entryEnvironments()) {
          await environment.depsOptimizer?.init();
          await environment.connect(address);
        }
      };
      handle ??= await startServer(
        options,
        entryEnvironment,
        server,
        options.context ?? context!,
        exportTypes,
      );
      await connect(handle.address);
      let address = handle.address;

      const bindWebSocket = () => {
        removeUpgradeListener?.();
        removeUpgradeListener = server.httpServer
          ? handleWebSocket(server.httpServer, address)
          : undefined;
      };

      /**
       * Replaces the Worker runtime so it is regenerated for `exportTypes`.
       * workerd needs a named export for every entrypoint, Durable Object, and
       * Workflow class, and those exports are baked into the Worker's entry
       * module at startup.
       */
      const restartRuntime = async () => {
        await handle?.close();
        handle = await startServer(
          options,
          entryEnvironment,
          server,
          options.context ?? context!,
          exportTypes,
        );
        await connect(handle.address);
        address = handle.address;
        bindWebSocket();
      };

      /**
       * Applies export types reported by the Worker. Returns `true` when they
       * no longer match what the running Worker was generated for, in which
       * case a runtime restart has been queued on `applying`.
       */
      let applying: Promise<void> = Promise.resolve();
      const applyExportTypes = (detected: ExportTypes): boolean => {
        const next = mergeExportTypes(configured, detected);
        if (!haveExportTypesChanged(exportTypes, next)) {
          return false;
        }
        exportTypes = next;
        applying = applying
          .catch(() => {})
          .then(restartRuntime)
          .catch((error: unknown) => {
            server.config.logger.error(
              `Failed to reload the Worker runtime: ${String(error)}`,
              {
                error: error instanceof Error ? error : undefined,
                timestamp: true,
              },
            );
          });
        return true;
      };

      if (input) {
        // Vite's internal CSS plugins rely on `buildStart` having run for the
        // client environment before a server environment transforms a module.
        // Vite does that while initializing the dev server, which is after
        // this hook, and evaluating the entry now would fail without it.
        await server.environments.client.pluginContainer.buildStart();
        // Detect up front so that the first request already reaches a Worker
        // exposing every entrypoint the entry module defines.
        const detected = await entryEnvironments()[0]?.requestExportTypes();
        if (detected && applyExportTypes(detected)) {
          await applying;
        }
        // From here on the entry reports its exports over HMR every time it is
        // re-evaluated, which is how entrypoints added later get picked up.
        for (const environment of entryEnvironments()) {
          environment.hot.on(WORKER_EXPORT_TYPES_EVENT, (data: unknown) => {
            if (!isExportTypes(data) || !applyExportTypes(data)) {
              return;
            }
            server.config.logger.info(
              "Worker exports changed, reloading the Worker runtime.",
              {
                timestamp: true,
              },
            );
          });
        }
      }

      if (!input) {
        // If there is no input, we are in SPA mode, so we don't need to route requests to the server.
        return;
      }
      bindWebSocket();
      return () => {
        server.middlewares.use(
          function distilledCloudflareProxyMiddleware(req, res) {
            const url = new NodeURL(
              req.originalUrl ?? req.url ?? "/",
              address.toString(),
            );
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
            // Without a listener a connection error is an unhandled `error`
            // event, which takes down the dev server. Requests in flight while
            // the Worker runtime is being replaced hit exactly that.
            request.on("error", (error) => {
              server.config.logger.error(
                `Worker request failed: ${error.message}`,
                {
                  error,
                  timestamp: true,
                },
              );
              if (!res.headersSent) {
                res.writeHead(502, { "content-type": "text/plain" });
              }
              res.end("Bad Gateway");
            });
          },
        );
        if (
          options.dev?.middlewareOrder === "pre" &&
          middlewareBoundary !== undefined
        ) {
          // Move the proxy middleware from the end of the stack to directly
          // after Vite's internal middlewares, ahead of the post middlewares
          // other plugins registered.
          const stack = server.middlewares.stack;
          const entry = stack.pop();
          if (entry) {
            stack.splice(middlewareBoundary, 0, entry);
          }
        }
      };
    },
  };
  plugins.push(plugin);
  return plugins;
}

const hasConfigureServerHook = (plugin: vite.Plugin): boolean => {
  const hook = plugin.configureServer;
  if (hook == null) return false;
  return typeof hook === "function" || typeof hook.handler === "function";
};
