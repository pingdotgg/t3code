import type * as Context from "effect/Context";
import type * as vite from "vite";
import type { BindingHooks, RuntimeServices, RuntimeWorker } from "../core/index.ts";
import type { BasePluginOptions } from "../rolldown/options.ts";
import {
  CLIENT_FALLBACK_ENTRY_ID,
  additionalModulesPlugin,
  cloudflareExternalsPlugin,
  nodejsAlsPlugin,
  nodejsImportWarningPlugin,
  nodejsUnenvPlugin,
  optionsPlugin,
  virtualModulesPlugin,
  wasmInitPlugin,
} from "../rolldown/plugins/index.ts";
import { dev } from "./dev-plugin.ts";
import { preview } from "./preview-plugin.ts";

export interface CloudflareVitePluginDevOptions {
  /**
   * Where the Worker request-proxy middleware registers relative to the
   * `configureServer` post middlewares of other plugins.
   *
   * - `"post"` (default): append in plugin order. Required by frameworks whose
   *   own dev middlewares must see requests first (e.g. Astro's prerender
   *   handler and dev handler).
   * - `"pre"`: insert directly after Vite's internal middlewares, ahead of the
   *   post middlewares other plugins registered. Use this when appending the
   *   Cloudflare plugin after a framework's config-file plugins and the
   *   framework registers its own Node request-bridge middleware that cannot
   *   handle the Worker environment (e.g. Waku's RSC bridge, which assumes a
   *   runnable Node environment).
   *
   * @default "post"
   */
  middlewareOrder?: "pre" | "post";
}

export interface CloudflareVitePluginOptions<
  B extends BindingHooks = BindingHooks,
> extends BasePluginOptions {
  worker?: Omit<RuntimeWorker<B>, "compatibilityDate" | "compatibilityFlags" | "modules">;
  context?: Context.Context<RuntimeServices>;
  dev?: CloudflareVitePluginDevOptions;
  /**
   * Named entrypoints the Worker binds to itself. workerd resolves those
   * bindings at startup, before the entry module has been evaluated and its
   * exports detected, so the dev Worker must export them from the start.
   */
  entrypoints?: ReadonlyArray<string>;
}

/**
 * Official `@cloudflare/vite-plugin` root name. vinext / Next-on-Workers
 * treat this exact name, or any `vite-plugin-cloudflare:*` prefix, as
 * "Cloudflare Workers path".
 */
export const OFFICIAL_CLOUDFLARE_VITE_PLUGIN_NAME = "vite-plugin-cloudflare";

/**
 * Alchemy's presence marker. Matches vinext's
 * `name.startsWith("vite-plugin-cloudflare:")` check without colliding
 * with the official plugin's exact name.
 */
export const ALCHEMY_CLOUDFLARE_VITE_PLUGIN_NAME = "vite-plugin-cloudflare:alchemy";

const officialCloudflareVitePluginPrefix = `${OFFICIAL_CLOUDFLARE_VITE_PLUGIN_NAME}:`;

const isOfficialCloudflareVitePlugin = (plugin: vite.Plugin): boolean =>
  plugin.name === OFFICIAL_CLOUDFLARE_VITE_PLUGIN_NAME ||
  (plugin.name.startsWith(officialCloudflareVitePluginPrefix) &&
    plugin.name !== ALCHEMY_CLOUDFLARE_VITE_PLUGIN_NAME);

const noopHook = (): undefined => undefined;

/**
 * Neutralize official `@cloudflare/vite-plugin` instances already in the
 * Vite plugin list. Vite flattens `config.plugins` into `userPlugins`
 * *before* `config()` hooks run, so splicing the array cannot unregister
 * them — but those entries are the same objects. Replacing their hooks
 * with no-ops (not `undefined`: `getSortedPluginsByHook("config")` has
 * already captured them) stops the official stack from running alongside
 * Alchemy's `distilled-cloudflare:*` plugins.
 *
 * Construction-time side effects inside `cloudflare()` still happen if
 * the app called the official factory. `ALCHEMY_CLOUDFLARE_VITE_INJECTED`
 * remains the way to skip that factory.
 */
export const disableOfficialCloudflareVitePlugins = async (
  plugins: ReadonlyArray<unknown> | undefined,
): Promise<number> => {
  let disabled = 0;
  const visit = async (entry: unknown): Promise<void> => {
    // Async plugin factories (e.g. RedwoodSDK's `redwood()`, which adds its
    // own `cloudflare()`) leave promises here. Vite resolves the same
    // promises, so their plugins are the same objects.
    if (isPromiseLike(entry)) {
      await visit(await entry);
      return;
    }
    if (Array.isArray(entry)) {
      for (const child of entry) await visit(child);
      return;
    }
    if (entry === null || typeof entry !== "object" || !("name" in entry)) {
      return;
    }
    const plugin = entry as vite.Plugin;
    if (typeof plugin.name !== "string" || !isOfficialCloudflareVitePlugin(plugin)) {
      return;
    }
    disableOfficialCloudflareVitePlugin(plugin);
    disabled += 1;
  };
  for (const entry of plugins ?? []) await visit(entry);
  return disabled;
};

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof (value as { then: unknown }).then === "function";

const disableOfficialCloudflareVitePlugin = (plugin: vite.Plugin): void => {
  const record = plugin as unknown as Record<string, unknown>;
  // Its own `applyToEnvironment` reads the config its no-op `config` hook
  // never resolved (`Expected resolvedPluginConfig to be defined`).
  if ("applyToEnvironment" in record) record.applyToEnvironment = () => false;
  // The root plugin's `config` only resolves the plugin's own config, which
  // runs the user's `config` customizer: frameworks hand their Worker
  // contributions through it and fail the build if it never runs (Flue's
  // `cloudflare({ config: flueWorkerConfig() })`). It stays, in place, so it
  // runs after the plugins listed before it, as it does under Wrangler. What
  // it resolves feeds only the hooks disabled here.
  const resolveConfig =
    plugin.name === OFFICIAL_CLOUDFLARE_VITE_PLUGIN_NAME ? record.config : undefined;
  if (typeof resolveConfig === "function") {
    record.config = async function (this: unknown, ...args: Array<unknown>) {
      try {
        await resolveConfig.apply(this, args);
      } catch {
        // Its config (e.g. a missing `wrangler.jsonc`) doesn't apply under
        // Alchemy, which configures the Worker itself.
      }
    };
  }
  for (const key of Object.keys(record)) {
    if (
      key === "name" ||
      key === "enforce" ||
      key === "apply" ||
      key === "applyToEnvironment" ||
      (key === "config" && typeof resolveConfig === "function")
    ) {
      continue;
    }
    const value = record[key];
    if (typeof value === "function") {
      record[key] = noopHook;
      continue;
    }
    if (
      value !== null &&
      typeof value === "object" &&
      "handler" in value &&
      typeof (value as { handler: unknown }).handler === "function"
    ) {
      (value as { handler: typeof noopHook }).handler = noopHook;
    }
  }
};

/**
 * Named so vinext takes the Workers path, and so a later `config()`
 * reader cannot mistake us for the official plugin. `order: "pre"`
 * runs before `vinext:config` scans `config.plugins`.
 */
const alchemyCloudflareVitePlugin = (): vite.Plugin => ({
  name: ALCHEMY_CLOUDFLARE_VITE_PLUGIN_NAME,
  enforce: "pre",
  config: {
    order: "pre",
    async handler(config) {
      await disableOfficialCloudflareVitePlugins(config.plugins);
      // Vite concatenates this with a user's own `server.fs.deny`, which
      // would otherwise replace Vite's defaults and expose `.env`.
      return { server: { fs: { deny: [...DENIED_FILES] } } };
    },
  },
});

/**
 * Files the dev server never serves: `@cloudflare/vite-plugin`'s list
 * (Vite's defaults, package-manager credentials, key stores, Wrangler's
 * secrets and state) plus the stack file and Alchemy's state.
 */
const DENIED_FILES = [
  ".env",
  ".env.*",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "*.{crt,pem,key,pfx,p12,p8,jks}",
  "**/.git/**",
  ".dev.vars",
  ".dev.vars.*",
  "**/.cloudflare/**",
  "**/.wrangler/**",
  "**/.alchemy/**",
  "alchemy.run.*",
];

/**
 * The empty entry the default build gives a client with no `index.html`, so
 * its output still receives `public/` and the Worker's imported assets.
 */
const clientFallbackPlugin = (): vite.Plugin => ({
  name: "distilled-cloudflare:client-fallback",
  applyToEnvironment: (environment) => environment.name === "client",
  resolveId: {
    filter: { id: /^virtual:cloudflare\/client-fallback-entry$/ },
    handler: (id) => (id === CLIENT_FALLBACK_ENTRY_ID ? `\0${id}` : undefined),
  },
  load: {
    filter: { id: /^\0virtual:cloudflare\/client-fallback-entry$/ },
    handler: (id) => (id === `\0${CLIENT_FALLBACK_ENTRY_ID}` ? "" : undefined),
  },
});

export default function cloudflareVitePlugin(
  options: CloudflareVitePluginOptions = {},
): vite.PluginOption {
  return [
    alchemyCloudflareVitePlugin(),
    optionsPlugin.vite(options),
    cloudflareExternalsPlugin.vite(options),
    nodejsAlsPlugin.vite(options),
    nodejsImportWarningPlugin.vite(options),
    nodejsUnenvPlugin.vite(options),
    virtualModulesPlugin.vite(options),
    wasmInitPlugin.vite(options),
    additionalModulesPlugin.vite(options),
    clientFallbackPlugin(),
    {
      name: "distilled-cloudflare:rsc",
      enforce: "pre",
      config() {
        return { rsc: { serverHandler: false } } as vite.UserConfig;
      },
    } as vite.Plugin,
    ...dev(options),
    preview(options),
    // Some of the composed plugins are conditional (e.g. the nodejs-compat
    // family) and resolve to `null`; filter them out so integrations that
    // post-process the returned plugins don't have to handle sparse entries.
  ].filter((plugin): plugin is vite.Plugin => plugin !== null);
}
