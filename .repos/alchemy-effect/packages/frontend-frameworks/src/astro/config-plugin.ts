// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Vendored from `@astrojs/cloudflare` v14.4.2 (`src/vite-plugin-config.ts`,
 * which the published package does not export).
 *
 * Serializes adapter settings into the `virtual:astro-cloudflare:config`
 * virtual module consumed by the vendored runtime handler. `isPrerender` is
 * environment-dependent: it is only `true` when the module is loaded by the
 * (build-only) `prerender` environment.
 */
import type * as vite from "vite";

const VIRTUAL_CONFIG_ID = "virtual:astro-cloudflare:config";
const RESOLVED_VIRTUAL_CONFIG_ID = "\0" + VIRTUAL_CONFIG_ID;

/**
 * The prerender-only render-scope installer (upstream's
 * `src/utils/prerender-scope.ts`), inlined into the virtual module: installs
 * an AsyncLocalStorage-backed render scope so each concurrent prerender
 * request collects its metadata (content entries, images) in its own store.
 * `installRenderScope` is first-wins, so calling it per request is
 * idempotent. Inlined rather than a separate runtime module because the
 * runtime is bundled (tsdown), so there is no stable file to import.
 */
const LOAD_PRERENDER_SCOPE = `() => Promise.all([import("node:async_hooks"), import("astro/app")]).then(([{ AsyncLocalStorage }, { installRenderScope }]) => ({ ensurePrerenderScope: () => { installRenderScope(new AsyncLocalStorage()); } }))`;

export interface CompileImageConfig {
  transformWithBinding: boolean;
}

export interface AstroCloudflareConfig {
  sessionKVBindingName: string;
  compileImageConfig: CompileImageConfig | null;
  /**
   * True when the Astro config uses the Cloudflare cache provider
   * (`cacheCloudflare()`). The handler then defaults responses without
   * cache intent to `Cloudflare-CDN-Cache-Control: no-store`.
   */
  cacheProviderEnabled: boolean;
}

export function createConfigPlugin(config: AstroCloudflareConfig): vite.Plugin {
  return {
    name: VIRTUAL_CONFIG_ID,
    resolveId: {
      filter: { id: new RegExp(`^${VIRTUAL_CONFIG_ID}$`) },
      handler() {
        return RESOLVED_VIRTUAL_CONFIG_ID;
      },
    },
    load: {
      filter: {
        id: new RegExp(`^${RESOLVED_VIRTUAL_CONFIG_ID.replace("\0", "\\0")}$`),
      },
      handler() {
        const isPrerender = this.environment?.name === "prerender";
        return [
          ...Object.entries(config).map(([k, v]) => `export const ${k} = ${JSON.stringify(v)};`),
          `export const isPrerender = ${isPrerender};`,
          // The import edge to the render-scope installer — the one module with
          // a `node:async_hooks` reference — must only exist in the prerender
          // worker's module graph, so the thunk is generated per environment.
          `export const loadPrerenderScope = ${isPrerender ? LOAD_PRERENDER_SCOPE : "undefined"};`,
        ].join("\n");
      },
    },
  };
}
