import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** Configuration for a Neon TanStackStart website. */
export type TanStackStartProps = FrameworkSiteProps & {};

/**
 * TanStack Start SSR and browser assets on Neon Functions using the existing Node framework target.
 *
 * Native framework development and HMR run without Neon cloud resources.
 * Apply `Alchemy.remote()` to use the live Function deployment during dev.
 * Packaging requires the optional `@vercel/nft` peer dependency.
 *
 * ### Creating a Website
 * **Example:** TanStackStart application
 * ```typescript
 * const site = yield* Neon.Website.TanStackStart("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Deployment Configuration
 * **Example:** Existing project and custom hostname
 * ```typescript
 * const site = yield* Neon.Website.TanStackStart("Web", {
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
export const TanStackStart = (id: string, props: TanStackStartProps = {}) =>
  makeFrameworkSite(id, props, {
    framework: "@alchemy.run/frontend-frameworks/tanstack-start",
    target: "@alchemy.run/frontend-frameworks/tanstack-start/neon",
  }).pipe(Namespace.push(id));
