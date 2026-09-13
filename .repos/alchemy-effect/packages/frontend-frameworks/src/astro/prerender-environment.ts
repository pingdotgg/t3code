/**
 * Build-side wiring for the `prerender` environment when it runs under
 * workerd (`prerenderEnvironment: "workerd"`, the default — the analogue of
 * upstream `@astrojs/cloudflare`'s `experimental.prerenderWorker` on
 * `@cloudflare/vite-plugin`).
 *
 * Astro builds the `prerender` environment before the `ssr` environment
 * (`buildApp` in astro's static build). When a custom prerenderer is
 * registered, astro core deliberately does not set the environment's build
 * input (its stock node entry `astro/entrypoints/prerender` would be wrong) —
 * the adapter must supply it. This plugin points the input at the same
 * vendored Worker server entrypoint the `ssr` environment builds, wrapped in
 * the rolldown plugin's worker-entry virtual module so the bundle gets the
 * identical treatment (unenv polyfill injection, default-export wrapping).
 * The `virtual:astro-cloudflare:config` module evaluates
 * `isPrerender === true` in this environment, which activates the vendored
 * runtime's `__astro_*` prerender protocol endpoints in the built worker.
 *
 * The rest of the worker treatment (workerd resolve conditions, `cloudflare:`
 * externals, nodejs-compat polyfills) comes from listing `prerender` as a
 * child worker environment of the Cloudflare vite plugin instead of skipping
 * it — see `makeIntegrationPluginOptions`.
 */
import { WORKER_ENTRY_PREFIX } from "@alchemy.run/cloudflare-runtime/rolldown/plugins";
import type * as vite from "vite";

/**
 * Vite plugin that assigns the worker-wrapped server entrypoint as the
 * `prerender` environment's build input. Build-only: the environment does not
 * exist in dev (workerd mode serves prerenderable routes through the entry
 * worker's dev-match path instead).
 */
export function createWorkerdPrerenderEnvironmentPlugin(
  serverEntrypoint: string,
): vite.Plugin {
  return {
    name: "@alchemy.run/frontend-frameworks/astro:workerd-prerender-environment",
    apply: "build",
    configEnvironment(name) {
      if (name !== "prerender") return;
      return {
        build: {
          rolldownOptions: {
            input: `${WORKER_ENTRY_PREFIX}${serverEntrypoint}`,
          },
        },
      };
    },
  };
}
