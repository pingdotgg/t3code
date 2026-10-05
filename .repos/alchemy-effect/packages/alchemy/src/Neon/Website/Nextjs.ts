import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** Configuration for a Neon Nextjs website. */
export type NextjsProps = FrameworkSiteProps;

/**
 * Next.js on Neon Functions using next build and the existing Node custom-server target, not OpenNext. The artifact contains .next, public, configuration, and traced runtime dependencies, preserving installed package versions.
 *
 * Native framework development and HMR run without Neon cloud resources.
 * Apply `Alchemy.remote()` to use the live Function deployment during dev.
 * Packaging requires the optional `@vercel/nft` peer dependency.
 * Exact-version Sharp Linux ARM64/glibc packages are integrity-checked and staged.
 * The example artifact passes isolated Node 24 image optimization and desktop/mobile
 * counter, server-action, and redirect navigation checks. The Fetch bridge preserves
 * request-origin metadata without rewriting redirect responses. Initial live deployment
 * and desktop/mobile interactions are verified. Updates may still serve the previous
 * artifact after Neon accepts a new deployment; full lifecycle acceptance remains incomplete.
 *
 * ### Creating a Website
 * **Example:** Nextjs application
 * ```typescript
 * const site = yield* Neon.Website.Nextjs("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Deployment Configuration
 * **Example:** Existing project and custom hostname
 * ```typescript
 * const site = yield* Neon.Website.Nextjs("Web", {
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
export const Nextjs = (id: string, props: NextjsProps = {}) =>
  makeFrameworkSite(id, props, {
    framework: "@alchemy.run/frontend-frameworks/nextjs/neon",
    target: "@alchemy.run/frontend-frameworks/nextjs/neon",
    layout: "next",
  }).pipe(Namespace.push(id));
