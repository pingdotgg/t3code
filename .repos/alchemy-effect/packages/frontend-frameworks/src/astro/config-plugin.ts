// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Vendored from `@astrojs/cloudflare` v14.1.3 (`src/vite-plugin-config.ts`,
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

export interface CompileImageConfig {
  base: string;
  assetsPrefix: string | undefined;
  imageServiceEntrypoint: string;
  buildAssets: string;
}

export interface AstroCloudflareConfig {
  sessionKVBindingName: string;
  compileImageConfig: CompileImageConfig | null;
  /**
   * True when the user has configured the Cloudflare cache provider. Not
   * currently supported by this package; always `false`.
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
        return [
          ...Object.entries(config).map(
            ([k, v]) => `export const ${k} = ${JSON.stringify(v)};`,
          ),
          `export const isPrerender = ${this.environment?.name === "prerender"};`,
        ].join("\n");
      },
    },
  };
}
