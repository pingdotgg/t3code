import type { BasePluginOptions } from "../rolldown/options.ts";
import {
  additionalModulesPlugin,
  cloudflareExternalsPlugin,
  nodejsAlsPlugin,
  nodejsImportWarningPlugin,
  nodejsUnenvPlugin,
  optionsPlugin,
  virtualModulesPlugin,
  wasmInitPlugin,
} from "../rolldown/plugins/index.ts";
import type {
  BindingHooks,
  RuntimeServices,
  RuntimeWorker,
} from "../core/index.ts";
import type * as Context from "effect/Context";
import type * as vite from "vite";
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
  worker?: Omit<
    RuntimeWorker<B>,
    "compatibilityDate" | "compatibilityFlags" | "modules"
  >;
  context?: Context.Context<RuntimeServices>;
  dev?: CloudflareVitePluginDevOptions;
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
export const ALCHEMY_CLOUDFLARE_VITE_PLUGIN_NAME =
  "vite-plugin-cloudflare:alchemy";

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
export const disableOfficialCloudflareVitePlugins = (
  plugins: ReadonlyArray<unknown> | undefined,
): number => {
  let disabled = 0;
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child);
      return;
    }
    if (entry === null || typeof entry !== "object" || !("name" in entry)) {
      return;
    }
    const plugin = entry as vite.Plugin;
    if (
      typeof plugin.name !== "string" ||
      !isOfficialCloudflareVitePlugin(plugin)
    ) {
      return;
    }
    disableOfficialCloudflareVitePlugin(plugin);
    disabled += 1;
  };
  for (const entry of plugins ?? []) visit(entry);
  return disabled;
};

const disableOfficialCloudflareVitePlugin = (plugin: vite.Plugin): void => {
  const record = plugin as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (
      key === "name" ||
      key === "enforce" ||
      key === "apply" ||
      key === "applyToEnvironment"
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
    handler(config) {
      disableOfficialCloudflareVitePlugins(config.plugins);
    },
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
