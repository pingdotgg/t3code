import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** Configuration for a Prisma Nuxt website. */
export interface NuxtProps extends FrameworkSiteProps {
  /** Serializable overrides merged over nuxt.config.*; nitro.preset is owned by the Node target. */
  nuxt?: Record<string, unknown>;
}

/**
 * Nuxt SSR and prerendered assets on Prisma Compute. The Node target owns Nitro’s node preset; do not override nitro.preset.
 *
 * Native framework development and HMR run without Prisma cloud resources.
 * Apply `Alchemy.remote()` to use the live Compute deployment during dev.
 * Packaging requires the optional `@vercel/nft` peer dependency.
 *
 * ### Creating a Website
 * **Example:** Nuxt application
 * ```typescript
 * const site = yield* Prisma.Website.Nuxt("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Deployment Configuration
 * **Example:** Existing project and custom hostname
 * ```typescript
 * const site = yield* Prisma.Website.Nuxt("Web", {
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
export const Nuxt = (id: string, props: NuxtProps = {}) =>
  makeFrameworkSite(id, props, {
    framework: "@alchemy.run/frontend-frameworks/nuxt",
    target: "@alchemy.run/frontend-frameworks/nuxt/node",
    options: { nuxt: props.nuxt },
  }).pipe(Namespace.push(id));
