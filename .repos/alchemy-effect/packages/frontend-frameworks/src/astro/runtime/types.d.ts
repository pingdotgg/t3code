// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Ambient declarations for the vendored `@astrojs/cloudflare` runtime
 * (adapted from upstream `virtual.d.ts`, minus the wrangler/vite-plugin
 * coupling). The `virtual:astro-cloudflare:config` module is served by this
 * package's config plugin (`src/config-plugin.ts`); `astro:static-paths` and
 * `astro:assets` are provided by Astro itself at build time.
 */

declare module "virtual:astro-cloudflare:config" {
  export const sessionKVBindingName: string;
  export const compileImageConfig: { transformWithBinding: boolean } | null;
  export const isPrerender: boolean;
  /** Only defined in the `prerender` environment. */
  export const loadPrerenderScope: (() => Promise<{ ensurePrerenderScope(): void }>) | undefined;
  export const cacheProviderEnabled: boolean;
}

declare module "astro:static-paths" {
  import type { RouteData, StaticPathsResult } from "astro";
  import type { BaseApp } from "astro/app";

  export class StaticPaths {
    constructor(app: BaseApp);
    getAll(): Promise<Array<{ pathname: string; route: RouteData }>>;
    getAllWithMetadata(options?: { staticImages?: boolean }): Promise<StaticPathsResult>;
  }
}

declare module "astro:assets" {
  import type { AstroConfig } from "astro";

  export const imageConfig: AstroConfig["image"];
}

declare namespace Cloudflare {
  interface Env {
    [key: string]: unknown;
    ASSETS: Fetcher;
  }
}

// These are globals (matching upstream's `virtual.d.ts`).
interface Env extends Cloudflare.Env {}
