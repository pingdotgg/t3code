import { defineNuxtConfig } from "nuxt/config";

/**
 * SPA-mode fixture: `ssr: false` disables server rendering for every page —
 * the worker (and prerenderer) emit only the app shell, and Vue renders
 * exclusively in the browser. Nitro server routes (`server/api/*`) still
 * execute in the worker; that split is what the live test pins.
 *
 * The `app.head` meta tag is the SHELL MARKER: it appears in the shell HTML
 * served for `/` and for deep links, proving a response is the app shell
 * rather than server-rendered page content (which must NOT appear in raw
 * HTML with `ssr: false`).
 */
export default defineNuxtConfig({
  compatibilityDate: "2026-07-01",
  telemetry: { enabled: false },
  ssr: false,
  app: {
    head: {
      meta: [{ name: "fixture", content: "nuxt-spa-shell" }],
    },
  },
});
