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

export default function cloudflareVitePlugin(
  options: CloudflareVitePluginOptions = {},
): vite.PluginOption {
  return [
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
