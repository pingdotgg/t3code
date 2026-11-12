import * as Namespace from "alchemy/Namespace";
import { resolveAstroOutput } from "alchemy/Website/AstroOutput";
import * as Effect from "effect/Effect";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** Configuration for a Neon Astro website. */
export type AstroProps = FrameworkSiteProps & {
  /** Serializable overrides merged over astro.config.*; the Node target owns adapter. */
  astro?: {
    /** Canonical deployment URL. */
    site?: string;
    /** Deployment base path. */
    base?: string;
    /**
     * Render on demand or prerender every page. Overrides the `output` in
     * your `astro.config.*`; leave it unset to use the file's value.
     * @default the config file's `output`, else `"server"`
     */
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
};

/**
 * Astro SSR and prerendered pages on Neon Functions. The Node target owns the adapter; omit adapter from astro.config.*. Set `output: "static"` in astro.config.* or astro.output to prerender every page.
 *
 * Native framework development and HMR run without Neon cloud resources.
 * Apply `Alchemy.remote()` to use the live Function deployment during dev.
 * Packaging requires the optional `@vercel/nft` peer dependency.
 *
 * ### Creating a Website
 * **Example:** Astro application
 * ```typescript
 * const site = yield* Neon.Website.Astro("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Deployment Configuration
 * **Example:** Existing project and custom hostname
 * ```typescript
 * const site = yield* Neon.Website.Astro("Web", {
 *   project,
 *   domain: "www.example.com",
 *   env: { API_BASE: "https://api.example.com" },
 *   function: { name: "Website" },
 * });
 * ```
 *
 * ### Static Output
 * **Example:** Prerendered documentation with a 404 page
 * ```typescript
 * const docs = yield* Neon.Website.Astro("Docs", {
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
  resolveAstroOutput({ rootDir: props.rootDir, output: props.astro?.output }).pipe(
    Effect.flatMap((output) =>
      makeFrameworkSite(id, props, {
        framework: "@alchemy.run/frontend-frameworks/astro",
        target: "@alchemy.run/frontend-frameworks/astro/neon",
        options: { astro: { ...props.astro, output } },
        notFoundHandling: "none",
      }),
    ),
    Namespace.push(id),
  );
