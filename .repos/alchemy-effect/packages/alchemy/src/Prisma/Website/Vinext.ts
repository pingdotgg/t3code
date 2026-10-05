import * as Namespace from "../../Namespace.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/** Configuration for a Prisma vinext website. */
export interface VinextProps extends FrameworkSiteProps {}

/**
 * Deploy a vinext application to Prisma Compute using vinext's Vite build and
 * vinext's production Node server on Compute's Bun runtime. Alchemy packages
 * the build output and traced, locally installed runtime dependencies; no
 * Dockerfile, registry, Wrangler, or OpenNext is required.
 *
 * Native `vinext dev` development and HMR run without Prisma cloud resources.
 * Apply `Alchemy.remote()` to use a live Compute deployment during dev.
 * Packaging requires the optional `@vercel/nft` peer dependency.
 *
 * ### Creating a Website
 * **Example:** vinext application
 * ```typescript
 * const site = yield* Prisma.Website.Vinext("Web", {
 *   rootDir: "./app",
 *   env: { GREETING: "Hello from vinext on Prisma!" },
 * });
 * ```
 *
 * ### Deployment Configuration
 * **Example:** Existing project and custom hostname
 * ```typescript
 * const site = yield* Prisma.Website.Vinext("Web", {
 *   project,
 *   domain: "www.example.com",
 *   compute: { destroyOldDeployment: true },
 * });
 * ```
 *
 * ### Persistent Data Cache
 * **Example:** Shared Redis cache
 * The resource injects the data-cache adapter automatically. Set `env.REDIS_URL`
 * to use Redis; otherwise the cache is process-local
 * and is lost on restart. Prisma Compute does not provision a Redis store.
 * ```typescript
 * const site = yield* Prisma.Website.Vinext("Web", {
 *   env: { REDIS_URL: Redacted.make("rediss://user:password@cache.example.com:6379") },
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Vinext = (id: string, props: VinextProps = {}) =>
  makeFrameworkSite(id, props, {
    framework: "@alchemy.run/frontend-frameworks/vinext/node",
    target: "@alchemy.run/frontend-frameworks/vinext/node",
  }).pipe(Namespace.push(id));
