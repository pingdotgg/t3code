/**
 * Astro's node-side server environments. They must be kept away from any
 * deploy target's worker treatment (unenv polyfills, workerd resolve
 * conditions, dependency pre-bundling) and they never contribute worker
 * modules to the build output: `astro` is a dev-only tooling helper;
 * `prerender` builds to `dist/server/.prerender/` and is deleted after
 * prerendering completes.
 *
 * Platform-neutral: this is a fact about Astro's own environment topology,
 * shared by the framework core (the collector's `skipEnvironments`) and by
 * target modules (e.g. the cloudflare vite plugin's `skipEnvironments`).
 */
export const NODE_ENVIRONMENTS = ["astro", "prerender"] as const;
