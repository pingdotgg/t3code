import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** Configuration for a Neon Octane website. */
export type OctaneProps = FrameworkSiteProps & {};

/**
 * Octane SSR and client assets on Neon Functions. Select node() from @alchemy.run/frontend-frameworks/octane/node-adapter in the project’s octane.config.ts.
 *
 * Native framework development and HMR run without Neon cloud resources.
 * Apply `Alchemy.remote()` to use the live Function deployment during dev.
 * Packaging requires the optional `@vercel/nft` peer dependency.
 *
 * ### Creating a Website
 * **Example:** Octane application
 * ```typescript
 * const site = yield* Neon.Website.Octane("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Deployment Configuration
 * **Example:** Existing project and custom hostname
 * ```typescript
 * const site = yield* Neon.Website.Octane("Web", {
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
export const Octane = (id: string, props: OctaneProps = {}) =>
  makeFrameworkSite(id, props, {
    framework: "@alchemy.run/frontend-frameworks/octane",
    target: "@alchemy.run/frontend-frameworks/octane/neon",
  }).pipe(Namespace.push(id));
