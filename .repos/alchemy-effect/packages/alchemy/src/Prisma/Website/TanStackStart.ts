import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** Configuration for a Prisma TanStackStart website. */
export interface TanStackStartProps extends FrameworkSiteProps {}

/**
 * TanStack Start SSR and browser assets on Prisma Compute using the existing Node framework target.
 *
 * Native framework development and HMR run without Prisma cloud resources.
 * Apply `Alchemy.remote()` to use the live Compute deployment during dev.
 * Packaging requires the optional `@vercel/nft` peer dependency.
 *
 * ### Creating a Website
 * **Example:** TanStackStart application
 * ```typescript
 * const site = yield* Prisma.Website.TanStackStart("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Deployment Configuration
 * **Example:** Existing project and custom hostname
 * ```typescript
 * const site = yield* Prisma.Website.TanStackStart("Web", {
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
export const TanStackStart = (id: string, props: TanStackStartProps = {}) =>
  makeFrameworkSite(id, props, {
    framework: "@alchemy.run/frontend-frameworks/tanstack-start",
    target: "@alchemy.run/frontend-frameworks/tanstack-start/node",
  }).pipe(Namespace.push(id));
