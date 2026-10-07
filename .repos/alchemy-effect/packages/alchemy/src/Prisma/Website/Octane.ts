import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** Configuration for a Prisma Octane website. */
export interface OctaneProps extends FrameworkSiteProps {}

/**
 * Octane SSR and client assets on Prisma Compute.
 *
 * `Prisma.Website.Octane` selects hosting and automatically wraps Octane's
 * default native Node output for Bun on Compute. Keep compiler and route
 * settings in `octane.config.ts` without an adapter. The legacy Node marker
 * adapter remains optional for existing projects.
 *
 * Native framework development and HMR run without Prisma cloud resources.
 * Apply `Alchemy.remote()` to use the live Compute deployment during dev.
 * Packaging requires the optional `@vercel/nft` peer dependency.
 *
 * ### Creating a Website
 * **Example:** Octane application
 * ```typescript
 * const site = yield* Prisma.Website.Octane("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Deployment Configuration
 * **Example:** Existing project and custom hostname
 * ```typescript
 * const site = yield* Prisma.Website.Octane("Web", {
 *   project,
 *   domain: "www.example.com",
 *   env: { API_BASE: "https://api.example.com" },
 *   compute: { destroyOldDeployment: true },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Octane = (id: string, props: OctaneProps = {}) =>
  makeFrameworkSite(id, props, {
    framework: "@alchemy.run/frontend-frameworks/octane",
    target: "@alchemy.run/frontend-frameworks/octane/node",
  }).pipe(Namespace.push(id));
