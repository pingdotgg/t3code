import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** Configuration for a Prisma Vite website. */
export interface ViteProps extends FrameworkSiteProps {
  /** Serializable overrides merged over vite.config.*. */
  vite?: {
    /** Build output directory. @default "dist" */
    outDir?: string;
    /** Public base path. @default "/" */
    base?: string;
  };
}

/**
 * Static Vite assets served on Prisma Compute. The project’s Vite plugins and configuration drive the build; native Vite HMR runs during development.
 *
 * Native framework development and HMR run without Prisma cloud resources.
 * Apply `Alchemy.remote()` to use the live Compute deployment during dev.
 * Packaging requires the optional `@vercel/nft` peer dependency.
 *
 * ### Creating a Website
 * **Example:** Vite application
 * ```typescript
 * const site = yield* Prisma.Website.Vite("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Deployment Configuration
 * **Example:** Existing project and custom hostname
 * ```typescript
 * const site = yield* Prisma.Website.Vite("Web", {
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
export const Vite = (id: string, props: ViteProps = {}) =>
  makeFrameworkSite(id, props, {
    framework: "@alchemy.run/frontend-frameworks/vite",
    target: "@alchemy.run/frontend-frameworks/vite/node",
    options: { vite: props.vite },
    notFoundHandling: "spa",
  }).pipe(Namespace.push(id));
