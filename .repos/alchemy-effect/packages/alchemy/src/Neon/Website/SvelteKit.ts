import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** Configuration for a Neon SvelteKit website. */
export type SvelteKitProps = FrameworkSiteProps & {
  /** Serializable SvelteKit v3 plugin configuration. The Node target owns adapter. */
  kit?: Record<string, unknown>;
};

/**
 * SvelteKit SSR and prerendered assets on Neon Functions. The Node target injects the adapter. For Kit v3, pass configuration through kit rather than a svelte.config.js file.
 *
 * Native framework development and HMR run without Neon cloud resources.
 * Apply `Alchemy.remote()` to use the live Function deployment during dev.
 * Packaging requires the optional `@vercel/nft` peer dependency.
 *
 * ### Creating a Website
 * **Example:** SvelteKit application
 * ```typescript
 * const site = yield* Neon.Website.SvelteKit("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Deployment Configuration
 * **Example:** Existing project and custom hostname
 * ```typescript
 * const site = yield* Neon.Website.SvelteKit("Web", {
 *   project,
 *   domain: "www.example.com",
 *   env: { API_BASE: "https://api.example.com" },
 *   function: { name: "Website" },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const SvelteKit = (id: string, props: SvelteKitProps = {}) =>
  makeFrameworkSite(id, props, {
    framework: "@alchemy.run/frontend-frameworks/sveltekit",
    target: "@alchemy.run/frontend-frameworks/sveltekit/neon",
    options: { kit: props.kit },
  }).pipe(Namespace.push(id));
