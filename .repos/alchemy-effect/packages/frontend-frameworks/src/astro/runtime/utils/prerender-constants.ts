// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
// Vendored from `@astrojs/cloudflare` v14.1.3 (`src/utils/prerender-constants.ts`).

/** Internal endpoint for fetching all static paths during prerendering */
export const STATIC_PATHS_ENDPOINT = "/__astro_static_paths";

/** Internal endpoint for rendering a specific page during prerendering */
export const PRERENDER_ENDPOINT = "/__astro_prerender";

/** Internal endpoint for fetching static images collected in workerd during `compile` builds */
export const STATIC_IMAGES_ENDPOINT = "/__astro_static_images";
