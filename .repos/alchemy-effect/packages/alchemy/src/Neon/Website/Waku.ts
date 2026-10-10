import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** Configuration for a Neon Waku website. */
export type WakuProps = FrameworkSiteProps & {
  /** Serializable overrides merged over waku.config.*. */
  waku?: {
    /** Application source directory. */
    srcDir?: string;
    /** Production output directory. */
    distDir?: string;
    /** Public URL base path. */
    basePath?: string;
  };
};

/**
 * Waku RSC and static pages on Neon Functions. The Node target selects Waku’s node adapter; do not set unstable_adapter.
 *
 * Native framework development and HMR run without Neon cloud resources.
 * Apply `Alchemy.remote()` to use the live Function deployment during dev.
 * Packaging requires the optional `@vercel/nft` peer dependency.
 *
 * ### Creating a Website
 * **Example:** Waku application
 * ```typescript
 * const site = yield* Neon.Website.Waku("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Deployment Configuration
 * **Example:** Existing project and custom hostname
 * ```typescript
 * const site = yield* Neon.Website.Waku("Web", {
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
export const Waku = (id: string, props: WakuProps = {}) =>
  makeFrameworkSite(id, props, {
    framework: "@alchemy.run/frontend-frameworks/waku",
    target: "@alchemy.run/frontend-frameworks/waku/neon",
    options: { waku: props.waku },
    htmlHandling: "drop-trailing-slash",
  }).pipe(Namespace.push(id));
