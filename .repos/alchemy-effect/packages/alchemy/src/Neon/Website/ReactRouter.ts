import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** Configuration for a Neon ReactRouter website. */
export type ReactRouterProps = FrameworkSiteProps & {};

/**
 * React Router SSR and browser assets on Neon Functions using the existing Node framework target.
 *
 * Native framework development and HMR run without Neon cloud resources.
 * Apply `Alchemy.remote()` to use the live Function deployment during dev.
 * Packaging requires the optional `@vercel/nft` peer dependency.
 *
 * ### Creating a Website
 * **Example:** ReactRouter application
 * ```typescript
 * const site = yield* Neon.Website.ReactRouter("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Deployment Configuration
 * **Example:** Existing project and custom hostname
 * ```typescript
 * const site = yield* Neon.Website.ReactRouter("Web", {
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
export const ReactRouter = (id: string, props: ReactRouterProps = {}) =>
  makeFrameworkSite(id, props, {
    framework: "@alchemy.run/frontend-frameworks/react-router",
    target: "@alchemy.run/frontend-frameworks/react-router/neon",
  }).pipe(Namespace.push(id));
