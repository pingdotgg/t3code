import * as Effect from "effect/Effect";
import type { MemoOptions } from "../../Command/Memo.ts";
import type { InputProps } from "../../Input.ts";
import { effectClass } from "../../Util/effect.ts";
import { Namespace } from "../KV/Namespace.ts";
import type { Providers } from "../Providers.ts";
import type { AssetsConfig } from "../Workers/Assets.ts";
import { VersionMetadata } from "../Workers/VersionMetadata.ts";
import {
  Worker,
  type NormalizedBindings,
  type WorkerAssetsConfig,
  type WorkerBindingProps,
  type WorkerProps,
} from "../Workers/Worker.ts";

/**
 * The default compatibility date when none is provided. Matches other
 * Cloudflare Website resources so deploy and local dev agree.
 */
const DEFAULT_COMPATIBILITY_DATE = "2026-05-12";

/**
 * Default Worker entry for a vinext Cloudflare app. Official vinext
 * examples wrap `vinext/server/fetch-handler` at this path.
 */
const DEFAULT_WORKER_ENTRY = "worker/index.ts";

export interface VinextProps<
  Bindings extends WorkerBindingProps = {},
> extends Omit<
  WorkerProps<Bindings>,
  "vite" | "main" | "assets" | "script" | "bundle" | "source" | "rules"
> {
  /**
   * Worker entry that delegates to vinext. Defaults to
   * `worker/index.ts` — the official vinext Cloudflare layout:
   *
   * ```typescript
   * import handler from "vinext/server/fetch-handler";
   * export default {
   *   fetch(request: Request, env: Env, ctx: ExecutionContext) {
   *     return handler.fetch(request, env, ctx);
   *   },
   * };
   * ```
   */
  main?: string;
  /**
   * The vinext project root (the directory containing `app/` or `pages/`
   * and `vite.config.ts`). Defaults to the process working directory.
   */
  rootDir?: string;
  /**
   * Controls which files are content-hashed to decide whether the Vite
   * build needs to re-run. By default every project file outside build
   * outputs and `node_modules` is hashed, plus the nearest lockfile.
   */
  memo?: MemoOptions;
  /**
   * Which Vite environments make up the deployed Worker.
   *
   * vinext's App Router build emits `rsc` + `ssr` + `client`. The
   * default points the Worker entry at `rsc` and bundles `ssr`
   * alongside it — the same shape vinext's official
   * `@cloudflare/vite-plugin` config uses (`viteEnvironment: { name:
   * "rsc", childEnvironments: ["ssr"] }`).
   *
   * @default { entry: "rsc", children: ["ssr"] }
   */
  viteEnvironments?: {
    entry?: string;
    children?: string[];
  };
  /**
   * Optional configuration for static asset routing behavior.
   * Defaults to assets-first (`runWorkerFirst` unset) with
   * `htmlHandling` / `notFoundHandling` set to `"none"` — the same
   * shape official vinext writes into `wrangler.jsonc`. Hashed
   * `/_next/static/*` chunks are served by the asset layer; the
   * Worker only `ASSETS.fetch`es files the RSC handler marks with
   * its static-file signal (e.g. `public/`). `runWorkerFirst: true`
   * would 404 those chunks: vinext does not fetch them itself.
   */
  assets?: AssetsConfig;
}

// These options are inspected while constructing the Worker. Resolve them in
// the outer props Effect; pass-through properties can remain deferred Inputs.
type VinextInput<Bindings extends WorkerBindingProps> = InputProps<
  VinextProps<Bindings>,
  "env" | "cache" | "compatibility" | "assets"
>;

/**
 * A Cloudflare Worker deployed from a [vinext](https://vinext.dev) app.
 *
 * vinext reimplements the Next.js API surface on Vite. `Vinext` is the
 * Alchemy-shaped deploy path: it runs the project's own `vite.config.ts`
 * (which must register `vinext()`) through Alchemy's wrangler-free
 * Cloudflare Vite plugin, then deploys the RSC Worker plus client
 * assets. There is no `wrangler.jsonc` and no
 * `@vinext/cloudflare deploy`.
 *
 * This is **not** `Cloudflare.Website.Nextjs`. That resource runs
 * `next build` through OpenNext. vinext never consumes `next build`
 * output — mixing the two stacks will fail.
 *
 * Install `vinext`, `@vitejs/plugin-rsc`,
 * `react-server-dom-webpack`, and `@alchemy.run/frontend-frameworks`
 * in the deploying project. Do **not** also register
 * `@cloudflare/vite-plugin` in `vite.config.ts` — Alchemy injects its
 * own Cloudflare plugin (`vite-plugin-cloudflare:alchemy`; vinext
 * matches the `vite-plugin-cloudflare:` prefix) and no-ops an official
 * plugin if one is still present. The Worker source is
 * `@alchemy.run/frontend-frameworks/vinext/source` (loaded with a
 * dynamic `import()`, like the other Website framework resources).
 *
 * Bindings are declared on this resource (`env`) and read from
 * `import { env } from "cloudflare:workers"` in server components,
 * route handlers, and server actions.
 *
 * The resource injects Alchemy's KV data-cache adapter into the Vite build
 * and local server. No Alchemy plugin or cache configuration is needed in
 * `vite.config.ts` (the same ISR codec is used by Redis / S3).
 * `Website.Vinext` provisions `VINEXT_KV_CACHE` (do not bind it in
 * `env`) and `alchemy deploy` seeds prerender pairs into it. Workers
 * Cache is enabled (`cache.enabled`) and `CF_VERSION_METADATA` is
 * bound. There is no `@vinext/cloudflare` data-cache adapter.
 *
 * ### Deploying a vinext App
 * **Example:** Basic vinext site
 * ```typescript
 * const site = yield* Cloudflare.Website.Vinext("Site");
 * ```
 *
 * **Example:** Bindings on the Worker
 * ```typescript
 * const site = yield* Cloudflare.Website.Vinext("Site", {
 *   env: {
 *     GREETING: "Hello from vinext on Cloudflare!",
 *   },
 * });
 * ```
 *
 * In a server component:
 * ```typescript
 * import { env } from "cloudflare:workers";
 *
 * export default function Page() {
 *   return <h1>{env.GREETING}</h1>;
 * }
 * ```
 *
 * **Example:** Custom Worker entry
 * ```typescript
 * const site = yield* Cloudflare.Website.Vinext("Site", {
 *   main: "worker/index.ts",
 * });
 * ```
 *
 * ### Class Form
 * **Example:** Declaring a Worker class
 * ```typescript
 * class Site extends Cloudflare.Website.Vinext<Site>()("Site") {}
 *
 * const site = yield* Site;
 * ```
 *
 * @resource
 * @product Website
 * @category Workers & Compute
 */
export const Vinext: {
  <Self>(): {
    <const Bindings extends WorkerBindingProps = {}, Req = never>(
      id: string,
      propsEff?:
        | VinextInput<Bindings>
        | Effect.Effect<VinextInput<Bindings>, never, Req>,
    ): Effect.Effect<Self, never, Req | Providers> & {
      new (): Worker<{
        [
          binding in keyof NormalizedBindings<Bindings, WorkerAssetsConfig>
        ]: NormalizedBindings<Bindings, WorkerAssetsConfig>[binding];
      }>;
    };
  };
  <const Bindings extends WorkerBindingProps = {}, Req = never>(
    id: string,
    propsEff?:
      | VinextInput<Bindings>
      | Effect.Effect<VinextInput<Bindings>, never, Req>,
  ): Effect.Effect<
    Worker<{
      [
        binding in keyof NormalizedBindings<Bindings, WorkerAssetsConfig>
      ]: NormalizedBindings<Bindings, WorkerAssetsConfig>[binding];
    }>,
    never,
    Req | Providers
  >;
} = (<const Bindings extends WorkerBindingProps = {}, Req = never>(
  id?: string,
  propsEff?:
    | VinextInput<Bindings>
    | Effect.Effect<VinextInput<Bindings>, never, Req>,
) =>
  id === undefined
    ? <const Bindings extends WorkerBindingProps = {}, Req = never>(
        id: string,
        propsEff?:
          | VinextInput<Bindings>
          | Effect.Effect<VinextInput<Bindings>, never, Req>,
      ) => effectClass(Vinext(id, propsEff))
    : Worker(
        id,
        Effect.gen(function* () {
          const props =
            (Effect.isEffect(propsEff) ? yield* propsEff : propsEff) ?? {};
          // Auto-provision the ISR/TPR data-cache KV. Official vinext
          // leaves a wrangler placeholder; Alchemy owns the namespace.
          // Do not bind VINEXT_KV_CACHE in user `env`.
          const cache = yield* Namespace(`${id}IsrCache`);
          const env = {
            ...props.env,
            VINEXT_KV_CACHE: cache,
            CF_VERSION_METADATA:
              props.env?.CF_VERSION_METADATA ?? VersionMetadata(),
          };
          return {
            ...props,
            env,
            cache: {
              enabled: true,
              ...props.cache,
            },
            compatibility: {
              date: props?.compatibility?.date ?? DEFAULT_COMPATIBILITY_DATE,
              flags: Array.from(
                new Set([
                  "nodejs_compat",
                  ...(props?.compatibility?.flags ?? []),
                ]),
              ),
            },
            assets: {
              htmlHandling: "none" as const,
              notFoundHandling: "none" as const,
              ...props?.assets,
            },
            source: {
              provider: "@alchemy.run/frontend-frameworks/vinext/source",
              devMode: "server",
              runtime: "node",
              rootDir: props?.rootDir,
              options: {
                main: props?.main ?? DEFAULT_WORKER_ENTRY,
                rootDir: props?.rootDir,
                memo: props?.memo,
                viteEnvironments: props?.viteEnvironments ?? {
                  entry: "rsc",
                  children: ["ssr"],
                },
              },
            },
          };
        }),
      )) as any;
