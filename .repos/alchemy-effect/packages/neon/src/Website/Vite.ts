import * as Namespace from "alchemy/Namespace";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** Configuration for a Neon Vite website. */
export type ViteProps = FrameworkSiteProps & {
  /** Serializable overrides merged over vite.config.*. */
  vite?: {
    /** Build output directory. @default "dist" */
    outDir?: string;
    /** Public base path. @default "/" */
    base?: string;
  };
};

/**
 * Static Vite assets served on Neon Functions. The project’s Vite plugins and configuration drive the build; native Vite HMR runs during development.
 *
 * Native framework development and HMR run without Neon cloud resources.
 * Apply `Alchemy.remote()` to use the live Function deployment during dev.
 * Packaging requires the optional `@vercel/nft` peer dependency.
 *
 * ### Creating a Website
 * **Example:** Vite application
 * ```typescript
 * const site = yield* Neon.Website.Vite("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Deployment Configuration
 * **Example:** Existing project and custom hostname
 * ```typescript
 * const site = yield* Neon.Website.Vite("Web", {
 *   project,
 *   domain: "www.example.com",
 *   env: { API_BASE: "https://api.example.com" },
 *   function: { name: "Website" },
 * });
 * ```
 *
 * **Example:** Publish DNS in Cloudflare
 * ```typescript
 * // The custom domain's DNS-only CNAME is published in the Cloudflare
 * // zone. Requires Cloudflare.providers() in the stack.
 * const site = yield* Neon.Website.Vite("Web", {
 *   domain: { name: "www.example.com", dns: Cloudflare.DNS.Adapter() },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Vite = (id: string, props: ViteProps = {}) =>
  makeFrameworkSite(id, props, {
    framework: "@alchemy.run/frontend-frameworks/vite",
    target: "@alchemy.run/frontend-frameworks/vite/neon",
    options: { vite: props.vite },
    notFoundHandling: "spa",
  }).pipe(Namespace.push(id));
