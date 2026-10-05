import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** Configuration for a Prisma Nextjs website. */
export interface NextjsProps extends FrameworkSiteProps {}

/**
 * Next.js on Prisma Compute using next build and the existing Node custom-server target, not OpenNext. The artifact contains .next, public, configuration, and traced runtime dependencies, preserving installed package versions.
 *
 * Native framework development and HMR run without Prisma cloud resources.
 * Apply `Alchemy.remote()` to use the live Compute deployment during dev.
 * Packaging requires the optional `@vercel/nft` peer dependency.
 *
 * ### Creating a Website
 * **Example:** Nextjs application
 * ```typescript
 * const site = yield* Prisma.Website.Nextjs("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Deployment Configuration
 * **Example:** Existing project and custom hostname
 * ```typescript
 * const site = yield* Prisma.Website.Nextjs("Web", {
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
export const Nextjs = (id: string, props: NextjsProps = {}) =>
  makeFrameworkSite(id, props, {
    framework: "@alchemy.run/frontend-frameworks/nextjs/node",
    target: "@alchemy.run/frontend-frameworks/nextjs/node",
    layout: "next",
  }).pipe(Namespace.push(id));
