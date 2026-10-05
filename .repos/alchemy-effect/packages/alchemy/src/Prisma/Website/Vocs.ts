import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** Configuration for a Prisma Vocs website. */
export interface VocsProps extends FrameworkSiteProps {
  /** Production output directory relative to rootDir, matching vocs.config.*. @default "dist" */
  outDir?: string;
}

/**
 * Vocs documentation and its Waku RSC handler on Prisma Compute. Install Vocs and its Waku peers alongside the framework integration.
 *
 * Native framework development and HMR run without Prisma cloud resources.
 * Apply `Alchemy.remote()` to use the live Compute deployment during dev.
 * Packaging requires the optional `@vercel/nft` peer dependency.
 *
 * ### Creating a Website
 * **Example:** Vocs application
 * ```typescript
 * const site = yield* Prisma.Website.Vocs("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Deployment Configuration
 * **Example:** Existing project and custom hostname
 * ```typescript
 * const site = yield* Prisma.Website.Vocs("Web", {
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
export const Vocs = (id: string, props: VocsProps = {}) =>
  makeFrameworkSite(id, props, {
    framework: "@alchemy.run/frontend-frameworks/vocs/node",
    target: "@alchemy.run/frontend-frameworks/vocs/node",
    options: { outDir: props.outDir },
    htmlHandling: "drop-trailing-slash",
  }).pipe(Namespace.push(id));
