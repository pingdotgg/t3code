// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Ambient app types injected into the user's project by the integration
 * (`injectTypes` in `astro:config:done`) — the fork of upstream
 * `@astrojs/cloudflare/types.d.ts`: `Astro.locals` carries the Cloudflare
 * runtime (`locals.runtime.ctx`, `caches`, `cf`).
 */
// Ambient global d.ts: a top-level `import type` would turn this file into a
// module and break the `App` namespace augmentation.
// oxlint-disable-next-line typescript/consistent-type-imports
type Runtime = import("./dist/runtime/utils/cf-helpers.d.ts").Runtime;

declare namespace App {
  interface Locals extends Runtime {}
}
