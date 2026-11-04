import * as NodePath from "node:path";
import type * as Context from "effect/Context";
import * as vite from "vite";
import type { RuntimeServices } from "../core/index.ts";
import { parseStaticRouting } from "../internal/workers-shared/shared/configuration/parseStaticRouting.ts";
import type { StaticRouting } from "../internal/workers-shared/shared/types.ts";
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
import { VITE_ASSET_REQUEST } from "./assets/ViteAssets.ts";
import { DistilledDevEnvironment } from "./dev-environment.ts";
import type { ServerHandle } from "./dev-server.ts";
import { configuredExportTypes, mergeExportTypes } from "./export-types.ts";
import type { CloudflareVitePluginOptions } from "./plugin.ts";
import { handleWebSocket } from "./websockets.ts";
import { forwardWorkerRequest, workerRequestUrl } from "./worker-request.ts";

let context: Context.Context<RuntimeServices> | undefined;

export function dev(options: CloudflareVitePluginOptions): Array<vite.Plugin> {
  const environmentNames = parseViteEnvironments(options);
  const isWorkerEnvironment = (environment: { name: string } | undefined) =>
    environment === undefined || environmentNames.includes(environment.name);
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
      optionsApi = resolvePluginApi<OptionsApi>(plugins ?? [], "distilled-cloudflare:options");
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
            // With no Worker entry at all — no `main`, and nothing the app's
            // config names for the entry environment — workerd serves assets
            // alone and evaluates nothing, so there is no runtime for these
            // environments to run modules in. Taking them over anyway would
            // only strip the app's own server-side dev tooling of the runnable
            // environment it expects (a framework's `vite dev` rendering, say).
            if (
              options.main === undefined &&
              optionsApi !== undefined &&
              Object.keys(optionsApi.input()).length === 0
            ) {
              return vite.createRunnableDevEnvironment(name, config);
            }
            return new DistilledDevEnvironment(name, config);
          },
        },
      };
      return {
        environments: Object.fromEntries(environmentNames.map((name) => [name, environment])),
      };
    },
    // The Worker environments' builds end when the dev server closes. Vite's
    // bundled dev mode (`experimental.bundledDev`) also builds the client
    // while serving, which must not take the runtime down with it.
    async buildEnd() {
      if (!isServerRestarting && isWorkerEnvironment(this.environment)) {
        await close();
      }
    },
    async closeBundle() {
      if (!isServerRestarting && isWorkerEnvironment(this.environment)) {
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
      // Frameworks can register multiple names for the same Worker entry.
      const inputs = [...new Set(Object.values(optionsApi.input()))];
      if (inputs.length > 1) {
        throw new Error(
          `Expected exactly one entry in the input, got ${inputs.length} entries: ${JSON.stringify(inputs)}`,
        );
      }
      const { createDefaultContext, startServer } = await import("./dev-server.ts");
      if (!options.context) {
        context ??= await createDefaultContext();
      }
      const [input] = inputs;
      if (input) {
        // An entry that can't be resolved fails the dev server, as under
        // `@cloudflare/vite-plugin`, rather than serving errors.
        const environment = server.environments[environmentNames[0]!];
        const resolved =
          (await environment?.pluginContainer.resolveId(input)) ??
          (await environment?.pluginContainer.resolveId(
            NodePath.resolve(server.config.root, input),
          ));
        if (!resolved) {
          throw new Error(
            `Failed to resolve Worker entrypoint "${input}" for environment "${environmentNames[0]}"`,
          );
        }
      }
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
          .filter((environment) => environment instanceof DistilledDevEnvironment);

      const connect = async (address: ServerHandle["address"]) => {
        for (const environment of entryEnvironments()) {
          await environment.depsOptimizer?.init();
          await environment.connect(address);
        }
      };
      // Match Cloudflare's Vite plugin: rebuild the dev server's environments,
      // hot channels and module runners after the runtime recovers. Framework
      // state may still refer to the crashed process even with the same ports.
      const onRuntimeRestart = () => {
        server.config.logger.warn(
          "The Worker runtime recovered after a crash; restarting the Vite dev server.",
          { timestamp: true },
        );
        if (!handle) return;
        void server.restart().catch((error: unknown) => {
          server.config.logger.error(
            `Failed to restart the Vite dev server after Worker recovery: ${String(error)}`,
            {
              error: error instanceof Error ? error : undefined,
              timestamp: true,
            },
          );
        });
      };
      handle ??= await startServer(
        options,
        entryEnvironment,
        server,
        options.context ?? context!,
        exportTypes,
        onRuntimeRestart,
      );
      await connect(handle.address);
      let address = handle.address;
      let proxySharedSecret = handle.proxySharedSecret;

      const bindWebSocket = () => {
        removeUpgradeListener?.();
        removeUpgradeListener = server.httpServer
          ? handleWebSocket(server.httpServer, address, proxySharedSecret)
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
          onRuntimeRestart,
        );
        await connect(handle.address);
        address = handle.address;
        proxySharedSecret = handle.proxySharedSecret;
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
            server.config.logger.error(`Failed to reload the Worker runtime: ${String(error)}`, {
              error: error instanceof Error ? error : undefined,
              timestamp: true,
            });
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
            server.config.logger.info("Worker exports changed, reloading the Worker runtime.", {
              timestamp: true,
            });
          });
        }
      }

      // An assets-only site (no input) still routes through the runtime, whose
      // router applies the asset rules; only a Worker takes WebSockets.
      if (input) bindWebSocket();

      // `runWorkerFirst` routes matching requests to the Worker ahead of Vite's
      // own middleware (which would otherwise serve a file at that path), as
      // `@cloudflare/vite-plugin`'s pre-middleware does. The Worker's router
      // applies the same rules once the request arrives.
      const staticRouting = input
        ? resolveStaticRouting(options.worker?.assets?.runWorkerFirst)
        : undefined;
      if (staticRouting) {
        server.middlewares.use(function distilledCloudflareRunWorkerFirst(req, res, next) {
          if (VITE_ASSET_REQUEST in req) return next();
          const { pathname } = workerRequestUrl(req.url, "http://localhost");
          if (
            matchesStaticRoutingRule(staticRouting.asset_worker ?? [], pathname) ||
            !matchesStaticRoutingRule(staticRouting.user_worker, pathname)
          ) {
            return next();
          }
          const url = workerRequestUrl(req.originalUrl ?? req.url, address);
          forwardWorkerRequest(req, res, url, proxySharedSecret, server.config.logger, next);
        });
      }

      return () => {
        server.middlewares.use(function distilledCloudflareProxyMiddleware(req, res, next) {
          // The Worker's own `ASSETS` calls run through Vite's middleware;
          // one Vite didn't serve must not come back to the Worker.
          if (VITE_ASSET_REQUEST in req) return next();
          const url = workerRequestUrl(req.originalUrl ?? req.url, address);
          forwardWorkerRequest(req, res, url, proxySharedSecret, server.config.logger, next);
        });
        if (options.dev?.middlewareOrder === "pre" && middlewareBoundary !== undefined) {
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

const resolveStaticRouting = (
  runWorkerFirst: boolean | ReadonlyArray<string> | undefined,
): StaticRouting | undefined =>
  runWorkerFirst === true
    ? { user_worker: ["/*"] }
    : Array.isArray(runWorkerFirst) && runWorkerFirst.length > 0
      ? parseStaticRouting([...runWorkerFirst])
      : undefined;

/** The glob-only rule matching of the asset worker's static routing. */
const matchesStaticRoutingRule = (rules: ReadonlyArray<string>, pathname: string) =>
  rules.some((rule) =>
    new RegExp(`^${rule.split("*").map(escapeRegex).join(".*")}$`).test(pathname),
  );

const escapeRegex = (value: string) => value.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");

const hasConfigureServerHook = (plugin: vite.Plugin): boolean => {
  const hook = plugin.configureServer;
  if (hook == null) return false;
  return typeof hook === "function" || typeof hook.handler === "function";
};
