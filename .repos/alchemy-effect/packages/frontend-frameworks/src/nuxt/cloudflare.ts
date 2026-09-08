/**
 * `@alchemy.run/frontend-frameworks/nuxt/cloudflare` — the Cloudflare Workers deploy target
 * for `@alchemy.run/frontend-frameworks/nuxt`.
 *
 * Nuxt 4's Cloudflare story is nitro's `cloudflare_module` preset: the
 * `.output` it produces is already self-contained workerd ESM
 * (`.output/server/index.mjs` + chunks, `.output/public` static assets with
 * prerendered pages and `_headers` merged in), so this target needs no
 * finishing pass. What it owns:
 *
 * - **`nitroPreset`** — `"cloudflare_module"`, enforced as the last word on
 *   the resolved nitro config.
 * - **`configureNitro`** — wrangler-free doctrine: `cloudflare.deployConfig:
 *   false` (nitro must never write a `wrangler.json` into user projects) and
 *   `cloudflare.nodeCompat: true` by default (without a wrangler config on
 *   disk nitro would otherwise skip its hybrid workerd node-compat; the
 *   deployed worker enables the `nodejs_compat` flag to match). Also wires
 *   the user-entry seam: a configured `main` becomes nitro's `entry`.
 * - **`entry`** — surfaces `config.main` as the generic user-entry carriage.
 *   Nitro's entry module is the exports seam: the emitted worker exports are
 *   exactly the entry module's exports, so a user entry that re-exports
 *   nitro's runtime handler (`nitropack/presets/cloudflare/runtime/cloudflare-module`)
 *   and adds its own classes gets Durable Objects et al. onto the same
 *   worker.
 * - **`bundle`** — workerd resolve conditions and the `cloudflare:`
 *   externals, for callers that post-process server code.
 * - **`devPlatform`** — the wrangler-free dev bridge: opens
 *   cloudflare-runtime's platform proxy (a local workerd instance hosting
 *   the configured binding hooks) and injects a nitro plugin that serves
 *   `event.context.cf` / `event.context.waitUntil` /
 *   `event.context.cloudflare = { request, env, context }` inside nitro's
 *   dev SSR worker thread (see `./dev/host.ts`).
 */
import { makeDeployTarget } from "../core/index.ts";
import { makeCloudflareDevPlatform } from "./dev/host.ts";
import type { NuxtTarget, NuxtTargetConfig } from "./Nuxt.ts";

/** The nitro deployment preset this target builds with. */
export const NITRO_PRESET = "cloudflare_module";

/**
 * The importable specifier of nitro's cloudflare-module runtime handler — the
 * module a USER worker entry re-exports to wrap the framework's fetch
 * handler (the "wrappable handler" half of the user-entry seam):
 *
 * ```ts
 * // worker-entry.mjs
 * import nitroHandler from "nitropack/presets/cloudflare/runtime/cloudflare-module";
 * export { MyDurableObject } from "./durable-object.mjs";
 * export default nitroHandler;
 * ```
 */
export const NITRO_HANDLER_SPECIFIER =
  "nitropack/presets/cloudflare/runtime/cloudflare-module";

/**
 * Create the Cloudflare Workers {@link NuxtTarget}. See the module doc for
 * the seams. The config's `compatibilityDate`/`compatibilityFlags` are
 * carried for serve/deploy consumers; the build itself only needs
 * `nodeCompat` (default `true`) and the optional user `main`.
 */
export const makeCloudflareTarget = (
  config: NuxtTargetConfig = {},
): NuxtTarget =>
  makeDeployTarget({
    platform: "cloudflare",
    config,
    bundle: {
      conditions: ["workerd", "worker", "module", "browser"],
      external: ["cloudflare:"],
    },
    entry: config.main !== undefined ? { main: config.main } : undefined,
    nitroPreset: NITRO_PRESET,
    configureNitro: (nitroConfig, _context) => {
      const cloudflare =
        nitroConfig.cloudflare !== null &&
        typeof nitroConfig.cloudflare === "object"
          ? nitroConfig.cloudflare
          : {};
      nitroConfig.cloudflare = {
        ...cloudflare,
        // Wrangler-free: never write a wrangler.json into the user project.
        deployConfig: false,
        // Without a wrangler config on disk, nitro only enables its hybrid
        // workerd node-compat when told to. The deployed worker enables the
        // `nodejs_compat` compatibility flag to match.
        nodeCompat: config.nodeCompat ?? true,
      };
      // NOTE: the user entry (context.entry) is deliberately NOT wired here.
      // The framework package sets it on the nitro INSTANCE at `nitro:init`:
      // a config-level entry would leak into the prerenderer's Node-preset
      // clone (it copies `options._config`) and a workerd-flavored entry
      // (importing `cloudflare:` modules) cannot load there.
    },
    // Dev: `event.context.cloudflare` served through cloudflare-runtime's
    // platform proxy (workerd hosting the binding hooks), bridged into
    // nitro's dev SSR worker thread by the shipped nitro plugin. Note the
    // proxy cannot host user worker-entry classes (Durable Objects declared
    // via the entry/exports seam only exist in the production build), so
    // DO namespace bindings are not servable in dev yet.
    devPlatform: makeCloudflareDevPlatform({
      compatibilityDate: config.compatibilityDate,
      compatibilityFlags: config.compatibilityFlags,
    }),
  });

/**
 * The deploy-target module contract (`resolveDeployTarget` accepts the
 * default export — or the named `target` export — as a value or factory).
 */
export const target = makeCloudflareTarget;

export default makeCloudflareTarget;
