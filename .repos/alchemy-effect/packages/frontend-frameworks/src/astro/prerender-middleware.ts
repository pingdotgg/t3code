// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Vendored from `@astrojs/cloudflare` v14.1.3
 * (`src/vite-plugin-dev-server-prerender-middleware.ts`).
 *
 * Enables Astro's node prerender middleware in dev: declaring the `prerender`
 * dev environment plus the marker symbol makes Astro's dev server serve
 * prerendered routes through its stock node pipeline, ahead of the Worker
 * proxy middleware.
 */
import type * as vite from "vite";

const devPrerenderMiddlewareSymbol = Symbol.for("astro.devPrerenderMiddleware");

export function createNodePrerenderPlugin(): vite.Plugin {
  return {
    name: "@alchemy.run/frontend-frameworks/astro:dev-server-prerender-middleware",
    config() {
      return { environments: { prerender: { dev: {} } } };
    },
    configureServer(server) {
      (server as unknown as Record<symbol, boolean>)[
        devPrerenderMiddlewareSymbol
      ] = true;
    },
  };
}
