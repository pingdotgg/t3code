import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** Configuration for a Prisma Waku website. */
export interface WakuProps extends FrameworkSiteProps {
  /** Serializable overrides merged over waku.config.*. */
  waku?: {
    /** Application source directory. */
    srcDir?: string;
    /** Production output directory. */
    distDir?: string;
    /** Public URL base path. */
    basePath?: string;
  };
}

/**
 * Waku RSC and static pages on Prisma Compute. The Node target selects Waku’s node adapter; do not set unstable_adapter.
 *
 * Native framework development and HMR run without Prisma cloud resources.
 * Apply `Alchemy.remote()` to use the live Compute deployment during dev.
 * Packaging requires the optional `@vercel/nft` peer dependency.
 *
 * ### Creating a Website
 * **Example:** Waku application
 * ```typescript
 * const site = yield* Prisma.Website.Waku("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Deployment Configuration
 * **Example:** Existing project and custom hostname
 * ```typescript
 * const site = yield* Prisma.Website.Waku("Web", {
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
export const Waku = (id: string, props: WakuProps = {}) =>
  makeFrameworkSite(id, props, {
    framework: "@alchemy.run/frontend-frameworks/waku",
    target: "@alchemy.run/frontend-frameworks/waku/node",
    options: { waku: props.waku },
    htmlHandling: "drop-trailing-slash",
  }).pipe(Namespace.push(id));
