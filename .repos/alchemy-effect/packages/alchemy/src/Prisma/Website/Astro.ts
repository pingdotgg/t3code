import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** Configuration for a Prisma Astro website. */
export interface AstroProps extends FrameworkSiteProps {
  /** Serializable overrides merged over astro.config.*; the Node target owns adapter. */
  astro?: {
    /** Canonical deployment URL. */
    site?: string;
    /** Deployment base path. */
    base?: string;
    /** Render on demand or prerender every page. @default "server" */
    output?: "server" | "static";
    /** Source directory relative to rootDir. @default "./src" */
    srcDir?: string;
    /** Static passthrough directory. @default "./public" */
    publicDir?: string;
    /** Production output directory. @default "./dist" */
    outDir?: string;
    /** Route trailing-slash policy. */
    trailingSlash?: "always" | "never" | "ignore";
  };
}

/**
 * Astro SSR and prerendered pages on Prisma Compute. The Node target owns the adapter; omit adapter from astro.config.*. Set astro.output to "static" to prerender every page.
 *
 * Native framework development and HMR run without Prisma cloud resources.
 * Apply `Alchemy.remote()` to use the live Compute deployment during dev.
 * Packaging requires the optional `@vercel/nft` peer dependency.
 *
 * ### Creating a Website
 * **Example:** Astro application
 * ```typescript
 * const site = yield* Prisma.Website.Astro("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Deployment Configuration
 * **Example:** Existing project and custom hostname
 * ```typescript
 * const site = yield* Prisma.Website.Astro("Web", {
 *   project,
 *   domain: "www.example.com",
 *   env: { API_BASE: "https://api.example.com" },
 *   compute: { destroyOldDeployment: true },
 * });
 * ```
 *
 * ### Static Output
 * **Example:** Prerendered documentation with a 404 page
 * ```typescript
 * const docs = yield* Prisma.Website.Astro("Docs", {
 *   rootDir: "./docs",
 *   astro: { output: "static" },
 *   assets: { notFoundHandling: "404-page" },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Astro = (id: string, props: AstroProps = {}) =>
  makeFrameworkSite(id, props, {
    framework: "@alchemy.run/frontend-frameworks/astro",
    target: "@alchemy.run/frontend-frameworks/astro/node",
    options: {
      astro: { ...props.astro, output: props.astro?.output ?? "server" },
    },
    notFoundHandling: "none",
  }).pipe(Namespace.push(id));
