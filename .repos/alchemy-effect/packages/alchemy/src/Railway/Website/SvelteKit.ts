import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** The framework-integration package that drives the SvelteKit build. */
export const SVELTEKIT_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/sveltekit";

/** The Node container deploy target for the SvelteKit build. */
export const SVELTEKIT_NODE_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/sveltekit/node";

export interface SvelteKitProps extends FrameworkSiteProps {
  /**
   * SvelteKit configuration passed to the `sveltekit(config)` Vite plugin
   * (kit v3 takes its config in memory — a `svelte.config.js` on disk is an
   * upstream error). The `adapter` field is injected by the Node deploy
   * target and may not be set here. Must be JSON-serializable (it persists
   * in state).
   */
  kit?: Record<string, unknown>;
}

/**
 * Deploy a SvelteKit application to Railway: kit's SSR server plus
 * prerendered assets on one `Railway.Service`. The Node deploy target
 * injects an in-memory kit adapter; do not set `adapter` in `kit`.
 *
 * During `alchemy dev` the site is SvelteKit's own dev server and no cloud
 * resources are created. `Alchemy.remote()` opts back into the live
 * Service path.
 *
 * ### Creating SvelteKit Sites
 * **Example:** Basic SvelteKit App
 * ```typescript
 * const site = yield* Railway.Website.SvelteKit("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Server Configuration
 * **Example:** Process Environment
 * ```typescript
 * const site = yield* Railway.Website.SvelteKit("Web", {
 *   rootDir: "./app",
 *   env: {
 *     API_BASE: "https://api.example.com",
 *   },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const SvelteKit = (id: string, props: SvelteKitProps = {}) =>
  makeFrameworkSite(id, props, {
    name: "SvelteKit",
    framework: SVELTEKIT_FRAMEWORK_SPECIFIER,
    target: SVELTEKIT_NODE_TARGET_SPECIFIER,
    options: props.kit ? { kit: props.kit } : undefined,
  }).pipe(Namespace.push(id));
