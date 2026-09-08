// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Vendored from `@astrojs/cloudflare` v14.1.3 (`src/utils/cf.ts`).
 *
 * Re-exports all pure helpers from `cf-helpers.ts` and adds
 * `injectSessionBinding` which depends on the virtual module.
 */
import { sessionKVBindingName } from "virtual:astro-cloudflare:config";
import type { ManifestLike } from "./cf-helpers.ts";

export type { ManifestLike, Runtime } from "./cf-helpers.ts";
export {
  createErrorPageFetch,
  createLocals,
  fallbackToAssets,
  getClientAddress,
  matchStaticAsset,
} from "./cf-helpers.ts";

/**
 * Injects the SESSION KV binding into the app manifest's session config.
 * Idempotent — safe to call on every request.
 */
export function injectSessionBinding(manifest: ManifestLike, env: Env): void {
  if (env[sessionKVBindingName]) {
    const sessionConfigOptions = manifest.sessionConfig?.options ?? {};
    Object.assign(sessionConfigOptions, {
      binding: env[sessionKVBindingName],
    });
  }
}
