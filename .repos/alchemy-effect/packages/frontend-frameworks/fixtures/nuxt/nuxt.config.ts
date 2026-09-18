import { defineNuxtConfig } from "nuxt/config";

/**
 * The USER's own nuxt.config.ts — loaded natively by the integration (c12
 * through the project's @nuxt/kit). The settings below are all observable
 * from the e2e suite, proving the file actually applied:
 *
 * - `runtimeConfig.public.fixtureMarker` renders on the home page.
 * - `routeRules["/prerendered"].prerender` makes nitro prerender that route
 *   into `.output/public` at build time.
 *
 * Note there is NO `nitro.preset` here: the deploy target owns the preset
 * (a user-set foreign preset is a hard error by design).
 */
export default defineNuxtConfig({
  compatibilityDate: "2026-07-01",
  telemetry: { enabled: false },
  runtimeConfig: {
    public: {
      fixtureMarker: "user-nuxt-config-loaded",
    },
  },
  routeRules: {
    "/prerendered": { prerender: true },
  },
});
