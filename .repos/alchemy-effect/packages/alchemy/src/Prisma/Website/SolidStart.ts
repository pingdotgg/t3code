import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** Configuration for a Prisma SolidStart website. */
export interface SolidStartProps extends FrameworkSiteProps {
  /** Serializable Nitro plugin options, including prerender and routeRules. The Node target owns preset. */
  nitro?: Record<string, unknown>;
}

/**
 * SolidStart SSR and prerendered assets on Prisma Compute. The integration owns the Nitro plugin; omit nitroV2Plugin() from vite.config.* and configure prerendering through nitro.
 *
 * Native framework development and HMR run without Prisma cloud resources.
 * Apply `Alchemy.remote()` to use the live Compute deployment during dev.
 * Packaging requires the optional `@vercel/nft` peer dependency.
 *
 * ### Creating a Website
 * **Example:** SolidStart application
 * ```typescript
 * const site = yield* Prisma.Website.SolidStart("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Deployment Configuration
 * **Example:** Existing project and custom hostname
 * ```typescript
 * const site = yield* Prisma.Website.SolidStart("Web", {
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
export const SolidStart = (id: string, props: SolidStartProps = {}) =>
  makeFrameworkSite(id, props, {
    framework: "@alchemy.run/frontend-frameworks/solidstart",
    target: "@alchemy.run/frontend-frameworks/solidstart/node",
    options: { nitro: props.nitro },
  }).pipe(Namespace.push(id));
