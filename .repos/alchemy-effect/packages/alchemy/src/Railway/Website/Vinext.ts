import * as Effect from "effect/Effect";
import * as Namespace from "../../Namespace.ts";
import { ref } from "../ref.ts";
import { REDIS_URL_ENV, type Redis } from "../Redis.ts";
import { makeFrameworkSite, type FrameworkSiteProps } from "./FrameworkSite.ts";

/**
 * The vinext Node framework module (it is its own deploy target — not
 * the Cloudflare Worker source).
 */
export const VINEXT_FRAMEWORK_SPECIFIER =
  "@alchemy.run/frontend-frameworks/vinext/node";

/** The Node container deploy target for the vinext build. */
export const VINEXT_NODE_TARGET_SPECIFIER =
  "@alchemy.run/frontend-frameworks/vinext/node";

export interface VinextProps extends FrameworkSiteProps {
  /**
   * Optional Redis for ISR / `"use cache"`. Alchemy writes `REDIS_URL`
   * onto the Service and injects the Redis data-cache adapter automatically.
   * Missing `REDIS_URL` (`alchemy dev`) falls back to memory.
   */
  redis?: Redis;
}

/**
 * Deploy a [vinext](https://vinext.dev) application to Railway as a
 * long-running Node process: vinext's Vite build, then vinext's production
 * server (`startProdServer`) on `PORT` (default 3000). **Not** the
 * Cloudflare Worker path — those wrappers are workerd.
 *
 * The image `npm install`s `vinext`, `react`, `react-dom`, and
 * `react-server-dom-webpack`, and bakes `dist/` into `/app`.
 *
 * During `alchemy dev` the site is vinext's own dev server (`vinext
 * dev`) and no cloud resources are declared; `Alchemy.remote()` opts
 * back into the full live deployment.
 *
 * ### Creating vinext Sites
 * **Example:** Basic vinext App
 * ```typescript
 * const site = yield* Railway.Website.Vinext("Web", {
 *   rootDir: "./app",
 * });
 * ```
 *
 * ### Server Configuration
 * **Example:** Process Environment
 * ```typescript
 * const site = yield* Railway.Website.Vinext("Web", {
 *   rootDir: "./app",
 *   env: {
 *     GREETING: "Hello from vinext on Railway!",
 *   },
 * });
 * ```
 *
 * **Example:** Redis data cache
 * ```typescript
 * const project = yield* Railway.Project("Project");
 * const redis = yield* Railway.Redis("Cache", { project });
 * const site = yield* Railway.Website.Vinext("Web", {
 *   project,
 *   redis,
 * });
 * ```
 *
 * @resource
 * @product Website
 */
export const Vinext = (id: string, propsIn: VinextProps = {}) =>
  Effect.gen(function* () {
    const { redis, ...props } = propsIn;
    return yield* makeFrameworkSite(
      id,
      {
        ...props,
        env:
          redis === undefined
            ? props.env
            : {
                [REDIS_URL_ENV]: ref(redis, REDIS_URL_ENV),
                ...props.env,
              },
      },
      {
        name: "Vinext",
        framework: VINEXT_FRAMEWORK_SPECIFIER,
        target: VINEXT_NODE_TARGET_SPECIFIER,
        install: ["vinext", "react", "react-dom", "react-server-dom-webpack"],
      },
    );
  }).pipe(Namespace.push(id));
