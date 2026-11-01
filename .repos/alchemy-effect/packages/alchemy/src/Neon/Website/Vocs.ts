import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** Configuration for a Neon Vocs website. */
export type VocsProps = FrameworkSiteProps & {
  /** Production output directory relative to rootDir, matching vocs.config.*. @default "dist" */
  outDir?: string;
};

/**
 * Vocs documentation and its Waku RSC handler on Neon Functions. Install Vocs and its Waku peers alongside the framework integration.
 *
 * Native framework development and HMR run without Neon cloud resources.
 * Apply `Alchemy.remote()` to use the live Function deployment during dev.
 * Packaging requires the optional `@vercel/nft` peer dependency.
 * The packaged example passes fresh Neon page, guide, and asset checks,
 * plus live desktop/mobile counter interactions and guide navigation.
 * Traced sensitive files remain rejected; diagnostics identify sanitized filenames.
 * Native dev uses Vocs's own Vite instance in an isolated process.
 *
 * ### Creating a Website
 * **Example:** Vocs application
 * ```typescript
 * const site = yield* Neon.Website.Vocs("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Deployment Configuration
 * **Example:** Existing project and custom hostname
 * ```typescript
 * const site = yield* Neon.Website.Vocs("Web", {
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
export const Vocs = (id: string, props: VocsProps = {}) =>
  makeFrameworkSite(id, props, {
    framework: "@alchemy.run/frontend-frameworks/vocs/neon",
    target: "@alchemy.run/frontend-frameworks/vocs/neon",
    options: { outDir: props.outDir },
    htmlHandling: "drop-trailing-slash",
  }).pipe(Namespace.push(id));
