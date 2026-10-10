import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** Configuration for a Neon Nuxt website. */
export type NuxtProps = FrameworkSiteProps & {
  /** Serializable overrides merged over nuxt.config.*; nitro.preset is owned by the Node target. */
  nuxt?: Record<string, unknown>;
};

/**
 * Nuxt SSR and prerendered assets on Neon Functions. The Node target owns Nitro’s node preset; do not override nitro.preset.
 *
 * Native framework development and HMR run without Neon cloud resources.
 * Apply `Alchemy.remote()` to use the live Function deployment during dev.
 * Packaging requires the optional `@vercel/nft` peer dependency.
 *
 * ### Creating a Website
 * **Example:** Nuxt application
 * ```typescript
 * const site = yield* Neon.Website.Nuxt("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Deployment Configuration
 * **Example:** Existing project and custom hostname
 * ```typescript
 * const site = yield* Neon.Website.Nuxt("Web", {
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
export const Nuxt = (id: string, props: NuxtProps = {}) =>
  makeFrameworkSite(id, props, {
    framework: "@alchemy.run/frontend-frameworks/nuxt",
    target: "@alchemy.run/frontend-frameworks/nuxt/neon",
    options: { nuxt: props.nuxt },
  }).pipe(Namespace.push(id));
