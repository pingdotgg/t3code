import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** Configuration for a Neon SolidStart website. */
export type SolidStartProps = FrameworkSiteProps & {
  /** Serializable Nitro plugin options, including prerender and routeRules. The Node target owns preset. */
  nitro?: Record<string, unknown>;
};

/**
 * SolidStart SSR and prerendered assets on Neon Functions. The integration owns the Nitro plugin; omit nitroV2Plugin() from vite.config.* and configure prerendering through nitro.
 *
 * Native framework development and HMR run without Neon cloud resources.
 * Apply `Alchemy.remote()` to use the live Function deployment during dev.
 * Packaging requires the optional `@vercel/nft` peer dependency.
 *
 * ### Creating a Website
 * **Example:** SolidStart application
 * ```typescript
 * const site = yield* Neon.Website.SolidStart("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Deployment Configuration
 * **Example:** Existing project and custom hostname
 * ```typescript
 * const site = yield* Neon.Website.SolidStart("Web", {
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
export const SolidStart = (id: string, props: SolidStartProps = {}) =>
  makeFrameworkSite(id, props, {
    framework: "@alchemy.run/frontend-frameworks/solidstart",
    target: "@alchemy.run/frontend-frameworks/solidstart/neon",
    options: { nitro: props.nitro },
  }).pipe(Namespace.push(id));
