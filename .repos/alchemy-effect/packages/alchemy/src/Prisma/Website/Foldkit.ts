import { Vite, type ViteProps } from "./Vite.ts";

/** Configuration for a client-only Foldkit website. */
export interface FoldkitProps extends ViteProps {}

/**
 * Deploy a Foldkit Vite application to Prisma Compute with SPA routing.
 * The project's Foldkit Vite plugin drives the build; native Vite HMR runs
 * during development without creating cloud resources.
 *
 * ### Creating a Website
 * **Example:** Foldkit application
 * ```typescript
 * const site = yield* Prisma.Website.Foldkit("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Multi-Page Routing
 * **Example:** Override the default SPA fallback
 * ```typescript
 * const site = yield* Prisma.Website.Foldkit("Web", {
 *   assets: { notFoundHandling: "404-page" },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Foldkit = (id: string, props: FoldkitProps = {}) =>
  Vite(id, {
    ...props,
    assets: { notFoundHandling: "single-page-application", ...props.assets },
  });
